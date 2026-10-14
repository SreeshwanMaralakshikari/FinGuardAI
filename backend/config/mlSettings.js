/**
 * @file config/mlSettings.js
 * @description Phase 10: settings of the ML scoring service, read from the environment in ONE place.
 *   Pure functions of `env` (default process.env), like config/opsSettings.js: the parser never throws
 *   (an unusable value falls back to "ML off" / the default) and validateMlSettings() reports problems
 *   to validateEnv() so a bad deploy fails fast with a clear message.
 *
 *   ML_ENABLED       "true" turns the ML engine on. Anything else (or unset) = rule engine only.
 *   ML_SERVICE_URL   origin of the Python service, e.g. https://finguardai-ml.onrender.com
 *                    (https required in production; http allowed for localhost in development/test)
 *   ML_API_KEY       shared secret sent in X-API-Key — the SAME value as the service's ML_API_KEY (32+ chars)
 *   ML_TIMEOUT_MS    how long a payment waits for the ML answer before the rules decide (default 2500)
 *   ML_COOLDOWN_MS   after a failure, skip ML for this long while it wakes up (default 60000; 0 = never skip)
 */
export const DEFAULT_ML_TIMEOUT_MS = 2500;
export const DEFAULT_ML_COOLDOWN_MS = 60_000;
export const MIN_ML_API_KEY_LENGTH = 32;

const TIMEOUT_RANGE = [200, 20_000];
const COOLDOWN_RANGE = [0, 600_000];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const isEnabled = (env) => String(env.ML_ENABLED ?? '').trim().toLowerCase() === 'true';

/** Whole number within [min, max], or the default when unset; `ok` false when set but unusable. */
const parseIntInRange = (raw, [min, max], fallback) => {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: fallback };
  if (!/^\d{1,9}$/.test(text)) return { ok: false, value: fallback };
  const value = Number(text);
  return value >= min && value <= max ? { ok: true, value } : { ok: false, value: fallback };
};

/**
 * The service origin without a trailing slash, or null when the value is not a usable URL.
 * Only an origin is accepted (no path, query or fragment): the client appends /predict and /health.
 */
const parseServiceUrl = (raw, env) => {
  const text = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!text) return { url: null, problem: 'ML_SERVICE_URL is missing' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { url: null, problem: `ML_SERVICE_URL is not a valid URL (got "${raw}")` };
  }
  if (url.origin !== text) {
    return { url: null, problem: `ML_SERVICE_URL must be an origin only, with no path, query or trailing slash (got "${raw}")` };
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local && !isProductionLikeEnv(env))) {
    return { url: url.origin, problem: null };
  }
  return { url: null, problem: `ML_SERVICE_URL must use https (http is allowed only for localhost in development/test; got "${raw}")` };
};

/** D-03 rule of config/environment.js, applied to the given env: anything but development/test is production-like. */
const isProductionLikeEnv = (env) =>
  !['development', 'test'].includes(String(env.NODE_ENV ?? '').trim().toLowerCase());

/**
 * Effective ML settings. `enabled` is true only when ML_ENABLED=true AND every required value is usable,
 * so a half-configured service can never be called (validateEnv refuses to start in that case anyway).
 * @returns {{ enabled: boolean, url: string|null, apiKey: string, timeoutMs: number, cooldownMs: number }}
 */
export const getMlSettings = (env = process.env) => {
  const timeout = parseIntInRange(env.ML_TIMEOUT_MS, TIMEOUT_RANGE, DEFAULT_ML_TIMEOUT_MS);
  const cooldown = parseIntInRange(env.ML_COOLDOWN_MS, COOLDOWN_RANGE, DEFAULT_ML_COOLDOWN_MS);
  const apiKey = String(env.ML_API_KEY ?? '').trim();
  const { url } = parseServiceUrl(env.ML_SERVICE_URL, env);
  const usable = isEnabled(env) && url !== null && apiKey.length >= MIN_ML_API_KEY_LENGTH;
  return {
    enabled: usable,
    url: usable ? url : null,
    apiKey: usable ? apiKey : '',
    timeoutMs: timeout.value,
    cooldownMs: cooldown.value,
  };
};

/** Problems with the ML variables, for validateEnv(). Empty when ML is off. @returns {string[]} */
export const validateMlSettings = (env = process.env) => {
  const raw = String(env.ML_ENABLED ?? '').trim().toLowerCase();
  const problems = [];
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    problems.push(`ML_ENABLED must be "true" or "false" (got "${env.ML_ENABLED}")`);
  }
  if (!isEnabled(env)) return problems;

  const { problem } = parseServiceUrl(env.ML_SERVICE_URL, env);
  if (problem) problems.push(problem);

  const apiKey = String(env.ML_API_KEY ?? '').trim();
  if (apiKey.length < MIN_ML_API_KEY_LENGTH) {
    problems.push(`ML_API_KEY must be at least ${MIN_ML_API_KEY_LENGTH} characters when ML_ENABLED=true (use the same value as the ML service)`);
  } else if (/replace-with|change-me|changeme/i.test(apiKey)) {
    problems.push('ML_API_KEY is still the placeholder from .env.example — generate a random one');
  }

  if (!parseIntInRange(env.ML_TIMEOUT_MS, TIMEOUT_RANGE, 0).ok) {
    problems.push(`ML_TIMEOUT_MS must be a whole number of milliseconds between ${TIMEOUT_RANGE[0]} and ${TIMEOUT_RANGE[1]} (got "${env.ML_TIMEOUT_MS}")`);
  }
  if (!parseIntInRange(env.ML_COOLDOWN_MS, COOLDOWN_RANGE, 0).ok) {
    problems.push(`ML_COOLDOWN_MS must be a whole number of milliseconds between ${COOLDOWN_RANGE[0]} and ${COOLDOWN_RANGE[1]} (got "${env.ML_COOLDOWN_MS}")`);
  }
  return problems;
};
