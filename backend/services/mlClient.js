/**
 * @file services/mlClient.js
 * @description Phase 10: HTTP client of the Python ML service (ml-service/). It never decides anything
 *   itself: predict() either returns a validated ML answer or throws an MlScoringError with a short
 *   `code`, and services/scoringService.js then falls back to the rule engine. A payment therefore
 *   waits at most ML_TIMEOUT_MS for the model.
 *
 *   Render free services sleep after 15 minutes without traffic and need tens of seconds to wake. So:
 *     • after a TIMEOUT / UNAVAILABLE / AUTH failure the client stops calling /predict for ML_COOLDOWN_MS
 *       (payments are scored by the rules instantly instead of each waiting for the timeout), and
 *     • it sends one background GET /health with a long timeout to wake the service; when that answers,
 *       the cool-down ends early.
 *   A 422 (our feature payload broke the contract — a bug) is logged loudly but causes no cool-down.
 *
 *   D-2: the ML service also sleeps while people use the rest of the app (it only gets traffic from payments).
 *   wakeUpIfIdle() starts the same background wake-up when nothing was heard from the service for 10 minutes;
 *   the backend calls it when a customer opens "Submit transaction" and when an admin opens the dashboard,
 *   so the service is usually awake before the payment arrives. It never runs on a timer (no Render hours
 *   are used beyond real visits). While a wake-up has been running for more than WAKE_SKIP_AFTER_MS (a cold
 *   start — a warm service answers /health at once) and nothing has answered since it began, predict() does
 *   not wait for its own timeout: it skips straight to the rules with COOLDOWN.
 *
 *   Error codes (stored as Transaction.scoring.fallbackReason):
 *     TIMEOUT · UNAVAILABLE (network error / 5xx) · AUTH (401) · CONTRACT (422) ·
 *     INVALID_RESPONSE (answer failed validation) · COOLDOWN (skipped while the service wakes) · ERROR
 */
import { ML_FEATURE_KEYS, ML_FALLBACK_REASONS } from '../utils/enums.js';

export { ML_FALLBACK_REASONS };

const WAKE_TIMEOUT_MS = 90_000;           // a Render free instance can take ~1 minute to start
const WAKE_SKIP_AFTER_MS = 2_000;         // a wake-up still running after this is a cold start
export const WARM_IDLE_MS = 10 * 60_000;  // Render sleeps after 15 min; nothing heard for 10 min → wake it
const MAX_REASONS = 10;
const MAX_TEXT = 300;
const FEATURE_SET = new Set(ML_FEATURE_KEYS);
const COOLDOWN_CODES = new Set(['TIMEOUT', 'UNAVAILABLE', 'AUTH', 'INVALID_RESPONSE']);

export class MlScoringError extends Error {
  /** @param {string} code one of ML_FALLBACK_REASONS @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'MlScoringError';
    this.code = code;
  }
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** E-09: release an answer whose body is not read, so its connection is freed now rather than at GC. */
const discardBody = async (res) => {
  try { await res.body?.cancel(); } catch { /* already consumed or closed */ }
};
const isShortString = (v, max = MAX_TEXT) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Validate the /predict answer; return only the fields the backend uses. Throws INVALID_RESPONSE.
 * Never trust a remote answer blindly: it is stored and shown to customers and analysts.
 */
export const parsePrediction = (body) => {
  const fail = (what) => { throw new MlScoringError('INVALID_RESPONSE', `ML response rejected: ${what}`); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('not an object');
  const { modelVersion, fraudProbability, fraudScore, baseValue, contributions, reasons, reasonFeatures } = body;

  if (!isShortString(modelVersion, 64)) fail('modelVersion');
  if (!isFiniteNumber(fraudProbability) || fraudProbability < 0 || fraudProbability > 1) fail('fraudProbability');
  if (!Number.isInteger(fraudScore) || fraudScore < 0 || fraudScore > 100) fail('fraudScore');
  if (!isFiniteNumber(baseValue)) fail('baseValue');

  if (!Array.isArray(contributions) || contributions.length !== ML_FEATURE_KEYS.length) fail('contributions');
  const seen = new Set();
  for (const c of contributions) {
    if (!c || !FEATURE_SET.has(c.feature) || seen.has(c.feature) || !isFiniteNumber(c.shap)) fail('contribution entry');
    if (!(isFiniteNumber(c.value) || isShortString(c.value, 32))) fail('contribution value');
    seen.add(c.feature);
  }

  if (!Array.isArray(reasons) || reasons.length > MAX_REASONS || !reasons.every((r) => isShortString(r))) fail('reasons');
  if (!Array.isArray(reasonFeatures) || reasonFeatures.length !== reasons.length
    || !reasonFeatures.every((f) => FEATURE_SET.has(f))) fail('reasonFeatures');

  return {
    modelVersion,
    fraudProbability,
    fraudScore,
    baseValue,
    contributions: contributions.map(({ feature, value, shap }) => ({ feature, value, shap })),
    reasons: [...reasons],
    reasonFeatures: [...reasonFeatures],
  };
};

/**
 * @param {object} options
 * @param {string} options.url        service origin (no trailing slash)
 * @param {string} options.apiKey
 * @param {number} options.timeoutMs
 * @param {number} options.cooldownMs
 * @param {typeof fetch} [options.fetchImpl]  injectable for tests
 * @param {() => number} [options.now]
 * @param {{ warn: Function, error: Function, info?: Function }} [options.logger]
 */
export const createMlClient = ({
  url, apiKey, timeoutMs, cooldownMs, fetchImpl = globalThis.fetch, now = Date.now, logger = console,
}) => {
  let cooldownUntil = 0;
  let wakeInFlight = null;
  let wakeStartedAt = 0;
  let lastContactAt = 0;                   // last time the service answered (predict or /health)
  const state = { lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null, modelVersion: null };

  const headers = (requestId) => ({
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    ...(requestId ? { 'X-Request-Id': String(requestId).slice(0, 64) } : {}),
  });

  const markFailure = (code) => {
    state.lastFailureAt = new Date(now());
    state.lastFailureCode = code;
    if (COOLDOWN_CODES.has(code) && cooldownMs > 0) cooldownUntil = now() + cooldownMs;
  };

  /** Background GET /health; ends the cool-down when the service answers. Never throws, one at a time. */
  const wakeUp = () => {
    if (wakeInFlight) return wakeInFlight;
    wakeStartedAt = now();
    wakeInFlight = (async () => {
      try {
        const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          if (isShortString(body?.modelVersion, 64)) state.modelVersion = body.modelVersion;
          cooldownUntil = 0;
          lastContactAt = now();
          return true;
        }
        await discardBody(res);
        return false;
      } catch {
        return false;
      } finally {
        wakeInFlight = null;
      }
    })();
    return wakeInFlight;
  };

  /** D-2: wake the service in the background unless it answered recently. @returns {boolean} a wake-up runs */
  const wakeUpIfIdle = (idleMs = WARM_IDLE_MS) => {
    if (wakeInFlight) return true;
    if (now() - lastContactAt < idleMs) return false; // heard from it recently: it is awake
    void wakeUp();
    return true;
  };

  /**
   * Score one payment. Resolves with the validated prediction or throws MlScoringError.
   * @param {Record<string, number|string>} features  from buildMlFeatures
   * @param {{ requestId?: string }} [options]
   */
  const predict = async (features, { requestId } = {}) => {
    if (now() < cooldownUntil) throw new MlScoringError('COOLDOWN', 'ML service is cooling down after a failure');
    if (wakeInFlight && now() - wakeStartedAt > WAKE_SKIP_AFTER_MS && lastContactAt < wakeStartedAt) {
      throw new MlScoringError('COOLDOWN', 'ML service is still starting up');
    }

    let res;
    try {
      res = await fetchImpl(`${url}/predict`, {
        method: 'POST',
        headers: headers(requestId),
        body: JSON.stringify({ features }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const code = timedOut ? 'TIMEOUT' : 'UNAVAILABLE';
      markFailure(code);
      void wakeUp();
      throw new MlScoringError(code, timedOut ? `ML service did not answer within ${timeoutMs} ms` : `ML service unreachable: ${err?.message ?? err}`);
    }

    if (res.status === 401) {
      await discardBody(res);
      markFailure('AUTH');
      logger.error('[mlClient] ML service rejected the API key (401) — ML_API_KEY must match on both services');
      throw new MlScoringError('AUTH', 'ML service rejected the API key');
    }
    if (res.status === 422) {
      const detail = await res.json().catch(() => null);
      markFailure('CONTRACT');
      logger.error('[mlClient] ML service rejected the feature payload (422) — backend and ml-service contracts differ:',
        JSON.stringify(detail?.error?.fields ?? detail ?? {}));
      throw new MlScoringError('CONTRACT', 'ML service rejected the feature payload');
    }
    if (!res.ok) {
      await discardBody(res);
      markFailure('UNAVAILABLE');
      void wakeUp();
      throw new MlScoringError('UNAVAILABLE', `ML service answered HTTP ${res.status}`);
    }

    let body;
    try {
      body = await res.json(); // the timeout signal also covers reading the body
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const code = timedOut ? 'TIMEOUT' : 'INVALID_RESPONSE';
      markFailure(code);
      throw new MlScoringError(code, timedOut ? `ML service did not answer within ${timeoutMs} ms` : 'ML response is not valid JSON');
    }
    let prediction;
    try {
      prediction = parsePrediction(body);
    } catch (err) {
      markFailure('INVALID_RESPONSE');
      throw err;
    }
    state.lastSuccessAt = new Date(now());
    lastContactAt = now();
    state.modelVersion = prediction.modelVersion;
    return prediction;
  };

  /** Snapshot for the admin status endpoint (no secrets: the host only, never the key). */
  const status = () => ({
    serviceHost: new URL(url).host,
    timeoutMs,
    cooldownMs,
    coolingDown: now() < cooldownUntil,
    cooldownEndsAt: now() < cooldownUntil ? new Date(cooldownUntil) : null,
    waking: wakeInFlight !== null,
    ...state,
  });

  return { predict, wakeUp, wakeUpIfIdle, status };
};
