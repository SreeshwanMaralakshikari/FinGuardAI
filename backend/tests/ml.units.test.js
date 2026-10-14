// tests/ml.units.test.js — Phase 10 ML integration: settings, feature builder, client, scoring (no database).
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getMlSettings, validateMlSettings, DEFAULT_ML_TIMEOUT_MS, DEFAULT_ML_COOLDOWN_MS } from '../config/mlSettings.js';
import { buildMlFeatures, ML_FEATURE_LABELS, ML_FEATURE_ALERT_TYPES } from '../services/mlFeatureBuilder.js';
import { createMlClient, parsePrediction, MlScoringError } from '../services/mlClient.js';
import {
  scoreTransaction, signalsFromReasonFeatures, signalsForMlAlert, applyRuleFloor, GENERIC_ML_REASON,
} from '../services/scoringService.js';
import { checkFraud, decisionForScore, resolveThresholds, hardRuleSignals } from '../services/fraudDetectionService.js';
import { MAX_AMOUNT } from '../validators/transactionValidators.js';
import { existsSync, readFileSync } from 'node:fs';
import { ML_FEATURE_KEYS } from '../utils/enums.js';
import { startFakeMlService, mlAnswer, FAKE_ML_KEY } from './helpers/fakeMlService.js';

const KEY = 'k'.repeat(40);

// ── config/mlSettings.js ────────────────────────────────────────────────────────────────────────
describe('ML settings', () => {
  const base = { NODE_ENV: 'production', ML_ENABLED: 'true', ML_SERVICE_URL: 'https://ml.example.com', ML_API_KEY: KEY };

  it('is off by default and reports no problems', () => {
    expect(getMlSettings({})).toEqual({ enabled: false, url: null, apiKey: '', timeoutMs: DEFAULT_ML_TIMEOUT_MS, cooldownMs: DEFAULT_ML_COOLDOWN_MS });
    expect(validateMlSettings({})).toEqual([]);
    expect(validateMlSettings({ ML_ENABLED: 'false', ML_SERVICE_URL: 'nonsense' })).toEqual([]);
  });

  it('enables with a valid https origin and key; strips one trailing slash', () => {
    const s = getMlSettings({ ...base, ML_SERVICE_URL: 'https://ml.example.com/', ML_TIMEOUT_MS: '1500', ML_COOLDOWN_MS: '0' });
    expect(s).toEqual({ enabled: true, url: 'https://ml.example.com', apiKey: KEY, timeoutMs: 1500, cooldownMs: 0 });
    expect(validateMlSettings(base)).toEqual([]);
  });

  it.each([
    [{ ML_ENABLED: 'yes' }, /ML_ENABLED must be "true" or "false"/],
    [{ ML_SERVICE_URL: '' }, /ML_SERVICE_URL is missing/],
    [{ ML_SERVICE_URL: 'not a url' }, /not a valid URL/],
    [{ ML_SERVICE_URL: 'https://ml.example.com/predict' }, /origin only/],
    [{ ML_SERVICE_URL: 'http://ml.example.com' }, /must use https/],
    [{ ML_SERVICE_URL: 'http://localhost:5001' }, /must use https/], // production: no plain http, even locally
    [{ ML_API_KEY: 'short' }, /at least 32 characters/],
    [{ ML_API_KEY: 'replace-with-'.padEnd(40, 'x') }, /placeholder/],
    [{ ML_TIMEOUT_MS: '50' }, /ML_TIMEOUT_MS/],
    [{ ML_TIMEOUT_MS: '2.5s' }, /ML_TIMEOUT_MS/],
    [{ ML_COOLDOWN_MS: '-1' }, /ML_COOLDOWN_MS/],
  ])('rejects %j', (override, message) => {
    const env = { ...base, ...override };
    expect(validateMlSettings(env).join('\n')).toMatch(message);
  });

  it('a half-configured service is never enabled', () => {
    expect(getMlSettings({ ...base, ML_API_KEY: 'short' }).enabled).toBe(false);
    expect(getMlSettings({ ...base, ML_SERVICE_URL: 'http://ml.example.com' }).enabled).toBe(false);
  });

  it('allows http://localhost in development and test only', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const env = { ...base, NODE_ENV, ML_SERVICE_URL: 'http://localhost:5001' };
      expect(validateMlSettings(env)).toEqual([]);
      expect(getMlSettings(env).url).toBe('http://localhost:5001');
    }
  });
});

// ── services/mlFeatureBuilder.js ────────────────────────────────────────────────────────────────
// 2026-01-01T09:00:00Z = 14:30 IST (hour 14); 2026-01-01T21:30:00Z = 03:00 IST next day (hour 3)
const AFTERNOON = new Date('2026-01-01T09:00:00Z');
const NIGHT = new Date('2026-01-01T21:30:00Z');

const PROFILE = {
  avgTransactionAmount: 1000,
  maxTransactionAmount: 4000,
  usualLocations: ['Mumbai', 'Pune'],
  usualHours: [14, 15, 16],
  usualPaymentMethods: ['UPI', 'CARD'],
  knownDeviceIds: ['dev-home'],
};
const TXN = {
  amount: 500, merchantName: 'Shop', merchantCategory: 'GROCERY', paymentMethod: 'UPI',
  location: { city: 'Mumbai' }, deviceId: 'dev-home', timestamp: AFTERNOON,
};
const DEFAULT_LIST = resolveThresholds(null).highRiskMerchants;

const build = (o = {}) => buildMlFeatures({
  transaction: { ...TXN, ...(o.transaction ?? {}) },
  behaviorProfile: o.behaviorProfile === undefined ? PROFILE : o.behaviorProfile,
  deviceReputation: o.deviceReputation ?? null,
  velocity: o.velocity ?? { perHour: 0, perDay: 1 },
  highRiskMerchants: o.highRiskMerchants ?? DEFAULT_LIST,
});

describe('buildMlFeatures', () => {
  it('produces exactly the 15 contract keys', () => {
    expect(Object.keys(build())).toEqual([...ML_FEATURE_KEYS]);
  });

  it('a normal payment of a known customer', () => {
    expect(build()).toEqual({
      amount: 500, amountToAvgRatio: 0.5, amountToMaxRatio: 0.125, txnsLastHour: 0, txnsLastDay: 1,
      isNewCity: 0, isNewDevice: 0, isNewPaymentMethod: 0, isUnusualHour: 0, hourOfDay: 14,
      deviceReputationScore: 100, deviceIsBlacklisted: 0, isHighRiskMerchant: 0, hasProfile: 1, paymentMethod: 'UPI',
    });
  });

  it('a new customer: no flags, neutral ratios, hasProfile 0', () => {
    const f = build({ behaviorProfile: null, transaction: { location: { city: 'Delhi' }, deviceId: 'x', timestamp: NIGHT } });
    expect(f).toMatchObject({
      amountToAvgRatio: 1, amountToMaxRatio: 1, isNewCity: 0, isNewDevice: 0, isNewPaymentMethod: 0,
      isUnusualHour: 0, hourOfDay: 3, hasProfile: 0,
    });
  });

  it('hour is taken in IST, not the server zone', () => {
    expect(build({ transaction: { timestamp: NIGHT } })).toMatchObject({ hourOfDay: 3, isUnusualHour: 1 });
  });

  it('city comparison is case- and space-insensitive (like the location rule)', () => {
    expect(build({ transaction: { location: { city: '  mumbai ' } } }).isNewCity).toBe(0);
    expect(build({ transaction: { location: { city: 'Delhi' } } }).isNewCity).toBe(1);
    expect(build({ transaction: { location: { city: 'Unknown' } } }).isNewCity).toBe(0);
  });

  it('device, method, reputation, blacklist', () => {
    const f = build({
      transaction: { deviceId: 'dev-new', paymentMethod: 'WALLET' },
      deviceReputation: { reputationScore: 22, isBlacklisted: true },
    });
    expect(f).toMatchObject({ isNewDevice: 1, isNewPaymentMethod: 1, deviceReputationScore: 22, deviceIsBlacklisted: 1, paymentMethod: 'WALLET' });
  });

  it('high-risk merchant uses the same normalised match as the rule', () => {
    expect(build({ transaction: { merchantCategory: 'crypto exchange' } }).isHighRiskMerchant).toBe(1);
    expect(build({ transaction: { merchantCategory: 'Casino' } }).isHighRiskMerchant).toBe(1);
    expect(build({ transaction: { merchantCategory: 'Casino' }, highRiskMerchants: ['GAMBLING'] }).isHighRiskMerchant).toBe(0);
  });

  it('ratios are capped at the contract maximum', () => {
    const f = build({ transaction: { amount: 5e9 }, behaviorProfile: { ...PROFILE, avgTransactionAmount: 0.01, maxTransactionAmount: 0.01 } });
    expect(f.amountToAvgRatio).toBe(1_000_000);
    expect(f.amountToMaxRatio).toBe(1_000_000);
  });

  it('every flag agrees with the matching rule of checkFraud', () => {
    const cases = [
      {},
      { transaction: { location: { city: 'Delhi' } } },
      { transaction: { deviceId: 'dev-new' } },
      { transaction: { timestamp: NIGHT } },
      { transaction: { merchantCategory: 'CASINO' } },
      { behaviorProfile: null, transaction: { deviceId: 'dev-new', location: { city: 'Delhi' }, timestamp: NIGHT } },
    ];
    for (const c of cases) {
      const f = build(c);
      const tx = { ...TXN, ...(c.transaction ?? {}) };
      const profile = c.behaviorProfile === undefined ? PROFILE : c.behaviorProfile;
      const { breakdown } = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null });
      const points = Object.fromEntries(breakdown.map((r) => [r.rule, r.points]));
      expect([c, f.isNewCity === 1]).toEqual([c, points.location > 0]);
      expect([c, f.isNewDevice === 1]).toEqual([c, points.device > 0]);
      expect([c, f.isUnusualHour === 1]).toEqual([c, points.time > 0]);
      expect([c, f.isHighRiskMerchant === 1]).toEqual([c, points.merchant > 0]);
    }
  });

  it('every feature has a label/formatter; alert types map to known types', () => {
    for (const key of ML_FEATURE_KEYS) expect(typeof ML_FEATURE_LABELS[key].format).toBe('function');
    expect(ML_FEATURE_LABELS.amountToAvgRatio.format(10)).toBe('10.0×');
    expect(ML_FEATURE_LABELS.hourOfDay.format(3)).toBe('03:00');
    expect(ML_FEATURE_LABELS.amount.format(125000)).toBe('₹1,25,000');
    for (const type of Object.values(ML_FEATURE_ALERT_TYPES)) {
      expect(['AMOUNT_ANOMALY', 'VELOCITY_BREACH', 'LOCATION_DEVIATION', 'NEW_DEVICE', 'UNUSUAL_HOUR', 'HIGH_RISK_MERCHANT']).toContain(type);
    }
  });
});

// ── services/mlClient.js ────────────────────────────────────────────────────────────────────────
describe('parsePrediction', () => {
  it('accepts a valid answer and keeps only the known fields', () => {
    const out = parsePrediction({ ...mlAnswer(), extra: 'ignored' });
    expect(Object.keys(out)).toEqual(['modelVersion', 'fraudProbability', 'fraudScore', 'baseValue', 'contributions', 'reasons', 'reasonFeatures']);
    expect(out.contributions).toHaveLength(15);
  });

  const bad = (mutate) => { const a = mlAnswer(); mutate(a); return a; };
  it.each([
    ['not an object', () => null],
    ['score out of range', () => bad((a) => { a.fraudScore = 101; })],
    ['fractional score', () => bad((a) => { a.fraudScore = 50.5; })],
    ['probability out of range', () => bad((a) => { a.fraudProbability = 1.2; })],
    ['missing contribution', () => bad((a) => { a.contributions.pop(); })],
    ['duplicate feature', () => bad((a) => { a.contributions[1].feature = a.contributions[0].feature; })],
    ['unknown feature', () => bad((a) => { a.contributions[0].feature = 'evil'; })],
    ['non-finite shap', () => bad((a) => { a.contributions[0].shap = null; })],
    ['reasons not strings', () => bad((a) => { a.reasons = [1]; a.reasonFeatures = ['amount']; })],
    ['reasonFeatures misaligned', () => bad((a) => { a.reasonFeatures = ['isNewDevice']; })],
    ['long model version', () => bad((a) => { a.modelVersion = 'v'.repeat(65); })],
  ])('rejects: %s', (_label, make) => {
    expect(() => parsePrediction(make())).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });
});

describe('createMlClient against a fake ML service', () => {
  let fake;
  const quietLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const client = (o = {}) => createMlClient({ url: fake.url, apiKey: FAKE_ML_KEY, timeoutMs: 400, cooldownMs: 60_000, logger: quietLogger, ...o });

  beforeAll(async () => { fake = await startFakeMlService(); });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.respondWith(() => ({ status: 200, body: mlAnswer() }));
  });

  it('sends the features with the API key and request id, returns the parsed answer', async () => {
    const features = build();
    const out = await client().predict(features, { requestId: 'req-1' });
    expect(out.fraudScore).toBe(88);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toBe('/predict');
    expect(fake.requests[0].body).toEqual({ features });
    expect(fake.requests[0].headers['x-request-id']).toBe('req-1');
  });

  it('TIMEOUT, then COOLDOWN without calling the service again', async () => {
    fake.respondWith(() => ({ delayMs: 1500, body: mlAnswer() }));
    const c = client();
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'COOLDOWN' });
    expect(fake.requests).toHaveLength(1);
    expect(c.status()).toMatchObject({ coolingDown: true, lastFailureCode: 'TIMEOUT' });
  });

  it('a successful wake-up (GET /health) ends the cool-down early', async () => {
    let now = 1_000;
    fake.respondWith(() => ({ status: 503, body: {} }));
    const c = client({ now: () => now });
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(c.status().coolingDown).toBe(true);
    await c.wakeUp();
    expect(c.status()).toMatchObject({ coolingDown: false, modelVersion: 'fg-xgb-test' });
    fake.respondWith(() => ({ status: 200, body: mlAnswer() }));
    now += 1;
    await expect(c.predict(build())).resolves.toMatchObject({ fraudScore: 88 });
  });

  it('cool-down expires after ML_COOLDOWN_MS (the background wake-up failed too)', async () => {
    // Stubbed fetch, so the wake-up's outcome is deterministic: /health answers 503 (still down).
    let now = 0;
    let predictStatus = 500;
    const res = (status, body) => ({ ok: status < 400, status, json: async () => body, body: { cancel: async () => {} } });
    const fetchImpl = async (url) => (url.endsWith('/health') ? res(503, {}) : res(predictStatus, predictStatus === 200 ? mlAnswer() : {}));
    const c = client({ now: () => now, cooldownMs: 10_000, fetchImpl });
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await c.wakeUp();                                     // finished, unsuccessfully: the cool-down stays
    now = 9_999;
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'COOLDOWN' });
    now = 10_000;
    predictStatus = 200;
    await expect(c.predict(build())).resolves.toMatchObject({ fraudScore: 88 });
  });

  it('401 → AUTH (logged, cool-down); 422 → CONTRACT (logged, no cool-down)', async () => {
    const wrongKey = client({ apiKey: 'w'.repeat(40) });
    await expect(wrongKey.predict(build())).rejects.toMatchObject({ code: 'AUTH' });
    expect(wrongKey.status().coolingDown).toBe(true);

    fake.respondWith(() => ({ status: 422, body: { error: { code: 'INVALID_FEATURES', fields: { amount: 'is required' } } } }));
    const c = client();
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'CONTRACT' });
    expect(c.status().coolingDown).toBe(false);
    expect(quietLogger.error).toHaveBeenCalled();
  });

  it('malformed JSON and invalid shapes → INVALID_RESPONSE', async () => {
    fake.respondWith(() => ({ status: 200, raw: '{not json' }));
    await expect(client().predict(build())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    fake.respondWith(() => ({ status: 200, body: { ...mlAnswer(), fraudScore: 'high' } }));
    await expect(client().predict(build())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('network failure (nothing listening) → UNAVAILABLE', async () => {
    const dead = createMlClient({ url: 'http://127.0.0.1:1', apiKey: FAKE_ML_KEY, timeoutMs: 400, cooldownMs: 0, logger: quietLogger });
    await expect(dead.predict(build())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

// ── services/scoringService.js ──────────────────────────────────────────────────────────────────
describe('scoreTransaction', () => {
  const tx = { ...TXN, deviceId: 'dev-new', location: { city: 'Delhi' }, timestamp: NIGHT, amount: 9000 };
  const profile = { ...PROFILE, transactionVelocity: { perHour: 0, perDay: 1 } };
  const fakeClient = (impl) => ({ predict: jest.fn(impl), wakeUp: jest.fn(), status: jest.fn() });

  it('ML disabled → exactly the rule result, engine RULES, no fallbackReason', async () => {
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: null });
    const rules = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null });
    expect(out).toEqual({ ...rules, scoring: { engine: 'RULES', ruleScore: rules.fraudScore } });
  });

  it('ML answers → ML score decides with the admin bands; rules kept for comparison', async () => {
    const thresholds = { scoreThresholds: { mediumMin: 20, highMin: 40, criticalMin: 90 } };
    const client = fakeClient(async () => parsePrediction(mlAnswer({ fraudScore: 60 })));
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds, mlClient: client });
    const rules = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds });

    expect(out).toMatchObject({ fraudScore: 60, ...decisionForScore(60, 9000, thresholds.scoreThresholds) });
    expect(out.riskLevel).toBe('HIGH');                        // 60 ≥ highMin 40 (not the default 50/75 bands)
    expect(out.estimatedLoss).toBe(6300);                      // 70 % of ₹9,000
    expect(out.breakdown).toEqual(rules.breakdown);
    expect(out.signals).toEqual(['NEW_DEVICE', 'AMOUNT_ANOMALY']);
    expect(out.reasons).toEqual(mlAnswer().reasons);
    expect(out.scoring).toMatchObject({ engine: 'ML', ruleScore: rules.fraudScore, modelVersion: 'fg-xgb-test', fraudProbability: 0.6, shapBaseValue: -5.5 });
    expect(out.scoring.shapValues[0]).toEqual({ feature: 'isNewDevice', label: 'New device for this customer', value: 'Yes', shap: 3.2 });
    expect(out.scoring.shapValues).toHaveLength(15);

    // the service received the features of THIS payment, built from the same data as the rules
    const [features] = client.predict.mock.calls[0];
    expect(features).toMatchObject({ isNewDevice: 1, isNewCity: 1, hourOfDay: 3, amount: 9000, amountToAvgRatio: 9 });
  });

  it('ML failure → the rule result, with the reason recorded', async () => {
    const client = fakeClient(async () => { throw new MlScoringError('TIMEOUT', 'slow'); });
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: client });
    const rules = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null });
    expect(out).toEqual({ ...rules, scoring: { engine: 'RULES', ruleScore: rules.fraudScore, fallbackReason: 'TIMEOUT', mlLatencyMs: expect.any(Number) } });
  });

  it('an unexpected error is ERROR (logged), still the rule result', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient(async () => { throw new TypeError('boom'); });
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: client });
    expect(out.scoring).toMatchObject({ engine: 'RULES', fallbackReason: 'ERROR' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a risky ML score without any reason gets a generic one; a LOW score does not', async () => {
    const noReasons = (fraudScore) => fakeClient(async () => parsePrediction(mlAnswer({ fraudScore, reasons: [], reasonFeatures: [] })));
    const risky = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: noReasons(55) });
    expect(risky.reasons).toEqual([GENERIC_ML_REASON]);
    // E-08: classified by the strongest positive SHAP feature (isNewDevice 3.2), not COMPOSITE
    expect(risky.signals).toEqual(['NEW_DEVICE']);
    const low = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: noReasons(3) });
    expect(low.reasons).toEqual([]);
    expect(low.riskLevel).toBe('LOW');
  });

  it('a LOW ML score lists no reasons even when the model returned some (SHAP values still stored)', async () => {
    const client = fakeClient(async () => parsePrediction(mlAnswer({ fraudScore: 1 })));
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: client });
    expect(out).toMatchObject({ riskLevel: 'LOW', recommendedAction: 'APPROVE', reasons: [] });
    expect(out.scoring.shapValues).toHaveLength(15);
  });

  it('signalsFromReasonFeatures de-duplicates and drops features without an alert type', () => {
    expect(signalsFromReasonFeatures(['amount', 'amountToAvgRatio', 'hasProfile', 'paymentMethod', 'isNewCity']))
      .toEqual(['AMOUNT_ANOMALY', 'LOCATION_DEVIATION']);
  });
});


// ── Error-check round fixes (E-01, E-06, E-08, D-1 rule floor) ─────────────────────────────────────
describe('amount limit is the same in all three services (E-01)', () => {
  const read = (rel) => {
    const url = new URL(rel, import.meta.url);
    return existsSync(url) ? readFileSync(url, 'utf8') : null;
  };

  it('backend validator, ML contract and the payment form all allow exactly ₹100 crore', () => {
    expect(MAX_AMOUNT).toBe(1_000_000_000);
    const python = read('../../ml-service/app/features.py');
    const form = read('../../frontend/src/pages/customer/SubmitTransaction.jsx');
    // Each service can be checked out alone (Render builds one folder); compare whatever is present.
    if (python) expect(Number(python.match(/^MAX_AMOUNT = ([\d_]+)$/m)?.[1].replaceAll('_', ''))).toBe(MAX_AMOUNT);
    if (form) expect(Number(form.match(/max: \{ value: ([\d_]+),/)?.[1].replaceAll('_', ''))).toBe(MAX_AMOUNT);
  });
});

describe('hardRuleSignals', () => {
  const casino = { ...TXN, merchantCategory: 'casino' };

  it('nothing for an ordinary payment', () => {
    expect(hardRuleSignals({ transaction: TXN, deviceReputation: { reputationScore: 90 }, thresholds: null })).toEqual([]);
  });

  it('a high-risk merchant (normalised match, admin list) and a blacklisted device', () => {
    expect(hardRuleSignals({ transaction: casino, deviceReputation: null, thresholds: null })).toEqual([{
      key: 'HIGH_RISK_MERCHANT', type: 'HIGH_RISK_MERCHANT', reason: 'High-risk merchant category detected: CASINO', feature: 'isHighRiskMerchant',
    }]);
    expect(hardRuleSignals({ transaction: TXN, deviceReputation: { reputationScore: 10, isBlacklisted: true }, thresholds: null })).toEqual([{
      key: 'BLACKLISTED_DEVICE', type: 'NEW_DEVICE', reason: 'Device is blacklisted (reputation score below minimum threshold)', feature: 'deviceIsBlacklisted',
    }]);
  });

  it('an amount above the admin high-value threshold (strictly above, like the amount rule)', () => {
    expect(hardRuleSignals({ transaction: { ...TXN, amount: 60_000 }, deviceReputation: null, thresholds: null })).toEqual([{
      key: 'HIGH_VALUE_AMOUNT', type: 'AMOUNT_ANOMALY', reason: 'Transaction amount ₹60,000 exceeds high-value threshold ₹50,000', feature: 'amount',
    }]);
    expect(hardRuleSignals({ transaction: { ...TXN, amount: 50_000 }, deviceReputation: null, thresholds: null })).toEqual([]);
    expect(hardRuleSignals({ transaction: { ...TXN, amount: 60_000 }, deviceReputation: null, thresholds: { amountThreshold: 100_000 } })).toEqual([]);
  });

  it('follows the admin list: a category removed from the list is no longer a hard signal', () => {
    expect(hardRuleSignals({ transaction: casino, deviceReputation: null, thresholds: { highRiskMerchants: ['CRYPTO_EXCHANGE'] } })).toEqual([]);
  });

  it('uses exactly the reason sentences of the rule engine', () => {
    const rules = checkFraud({ transaction: casino, behaviorProfile: null, deviceReputation: { reputationScore: 10, isBlacklisted: true }, thresholds: null });
    for (const { reason } of hardRuleSignals({ transaction: casino, deviceReputation: { reputationScore: 10, isBlacklisted: true }, thresholds: null })) {
      expect(rules.reasons).toContain(reason);
    }
  });
});

describe('applyRuleFloor', () => {
  const bands = { mediumMin: 25, highMin: 50 };
  it.each([
    // [mlScore, ruleScore, hard, expected]
    [0, 35, true, 35],      // casino from a known device: rules' MEDIUM score
    [0, 80, true, 49],      // capped just below HIGH: the floor alone never holds or blocks
    [30, 35, true, 35],     // raised within MEDIUM
    [40, 35, true, null],   // the model is already higher
    [70, 90, true, null],   // the model holds it anyway
    [0, 20, true, null],    // the rules themselves say LOW
    [0, 60, false, null],   // no hard signal: the model decides
  ])('ml %i, rules %i, hard %s → %s', (ml, rule, hard, expected) => {
    expect(applyRuleFloor(ml, rule, hard, bands)).toBe(expected);
  });

  it('uses the admin bands', () => {
    expect(applyRuleFloor(0, 80, true, { mediumMin: 20, highMin: 40 })).toBe(39);
    expect(applyRuleFloor(0, 35, true, { mediumMin: 40, highMin: 60 })).toBeNull();
  });
});

describe('scoreTransaction with the rule floor', () => {
  const fakeClient = (answer) => ({ predict: jest.fn(async () => parsePrediction(mlAnswer(answer))), wakeUp: jest.fn(), status: jest.fn() });
  const profile = { ...PROFILE, transactionVelocity: { perHour: 0, perDay: 1 } };
  const lowAnswer = { fraudScore: 0, fraudProbability: 0.001, reasons: [], reasonFeatures: [], top: { amount: -0.4 } };

  it('a casino payment the model rates 0 becomes the rules\' MEDIUM score, with the policy reason first', async () => {
    const tx = { ...TXN, merchantCategory: 'CASINO' };
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: fakeClient(lowAnswer) });
    const rules = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null });
    expect(rules.fraudScore).toBe(35);
    expect(out).toMatchObject({ fraudScore: 35, riskLevel: 'MEDIUM', recommendedAction: 'OTP', signals: ['HIGH_RISK_MERCHANT'] });
    expect(out.reasons).toEqual(['High-risk merchant category detected: CASINO']);
    expect(out.scoring).toMatchObject({ engine: 'ML', ruleScore: 35, mlScore: 0, ruleFloor: true });
    expect(out.scoring.signals).toEqual(['HIGH_RISK_MERCHANT']);   // stored, so an idempotent replay classifies the same way
    expect(out.scoring.shapValues).toHaveLength(15);               // the model's explanation is still kept
  });

  it('the floor never goes above MEDIUM, even when the rules alone would block', async () => {
    const tx = { ...TXN, merchantCategory: 'CASINO', deviceId: 'dev-new', amount: 60_000 };
    const rep = { reputationScore: 10, isBlacklisted: true };
    const rules = checkFraud({ transaction: tx, behaviorProfile: profile, deviceReputation: rep, thresholds: null });
    expect(rules.riskLevel).toBe('CRITICAL');
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: rep, thresholds: null, mlClient: fakeClient(lowAnswer) });
    expect(out).toMatchObject({ fraudScore: 49, riskLevel: 'MEDIUM', recommendedAction: 'OTP' });
    expect(out.reasons.slice(0, 2)).toEqual([
      'Device is blacklisted (reputation score below minimum threshold)',
      'High-risk merchant category detected: CASINO',
    ]);
    expect(out.signals).toEqual(['NEW_DEVICE', 'HIGH_RISK_MERCHANT', 'AMOUNT_ANOMALY']);
  });

  it('a huge payment from the customer\'s own device and city is at least MEDIUM (the model alone said LOW)', async () => {
    const tx = { ...TXN, amount: 500_000_000 };          // ₹50 crore; the live model scores this about 2/100
    const answer = { ...lowAnswer, fraudScore: 2, fraudProbability: 0.02, reasons: ['Payment amount of ₹50,00,00,000 raised the risk'], reasonFeatures: ['amount'], top: { amount: 0.2 } };
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: fakeClient(answer) });
    expect(out).toMatchObject({ fraudScore: 35, riskLevel: 'MEDIUM', signals: ['AMOUNT_ANOMALY'] });
    // the rule sentence replaces the model's sentence about the same fact (no duplicate)
    expect(out.reasons).toEqual(['Transaction amount ₹50,00,00,000 exceeds high-value threshold ₹50,000']);
    expect(out.scoring).toMatchObject({ mlScore: 2, ruleScore: 35, ruleFloor: true });
  });

  it('a model score above the floor is left alone (no ruleFloor flag)', async () => {
    const tx = { ...TXN, merchantCategory: 'CASINO' };
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: fakeClient({ fraudScore: 88 }) });
    expect(out).toMatchObject({ fraudScore: 88, riskLevel: 'CRITICAL' });
    expect(out.scoring).toMatchObject({ mlScore: 88 });
    expect(out.scoring.ruleFloor).toBeUndefined();
  });

  it('no hard signal: a LOW model score stays LOW although the rules say MEDIUM', async () => {
    const tx = { ...TXN, deviceId: 'dev-new', location: { city: 'Delhi' } }; // new device + new city = 35 for the rules
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: profile, deviceReputation: null, thresholds: null, mlClient: fakeClient(lowAnswer) });
    expect(out.scoring.ruleScore).toBeGreaterThanOrEqual(25);
    expect(out).toMatchObject({ fraudScore: 0, riskLevel: 'LOW', reasons: [] });
    expect(out.scoring.ruleFloor).toBeUndefined();
  });
});

describe('signalsForMlAlert (E-08)', () => {
  const prediction = (reasonFeatures, top) => parsePrediction(mlAnswer({
    reasons: reasonFeatures.map((f) => `reason for ${f}`), reasonFeatures, top,
  }));

  it('uses the reason features when they map to alert types', () => {
    expect(signalsForMlAlert(prediction(['isNewCity'], { isNewCity: 1 }), ['NEW_DEVICE'])).toEqual(['LOCATION_DEVIATION']);
  });

  it('otherwise the strongest positive SHAP feature with a type', () => {
    expect(signalsForMlAlert(prediction(['hasProfile'], { hasProfile: 2, txnsLastHour: 1.5, isNewDevice: 0.5 }), []))
      .toEqual(['VELOCITY_BREACH']);
  });

  it('otherwise the rule engine\'s signals', () => {
    expect(signalsForMlAlert(prediction([], { hasProfile: 2, paymentMethod: 1 }), ['AMOUNT_ANOMALY'])).toEqual(['AMOUNT_ANOMALY']);
  });
});

describe('ML fallback logging (E-06)', () => {
  it('a fallback other than COOLDOWN is logged with the request id; COOLDOWN is not', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = (code) => ({ predict: jest.fn(async () => { throw new MlScoringError(code, 'x'); }), wakeUp: jest.fn(), status: jest.fn() });
    await scoreTransaction({ transaction: TXN, behaviorProfile: null, deviceReputation: null, thresholds: null, requestId: 'req-42', mlClient: failing('TIMEOUT') });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('req-42'));
    warn.mockClear();
    await scoreTransaction({ transaction: TXN, behaviorProfile: null, deviceReputation: null, thresholds: null, requestId: 'req-43', mlClient: failing('COOLDOWN') });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('ML wake-up on visits (D-2)', () => {
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, body: { cancel: async () => {} } });
  /** fetch stub: /health resolves when `release()` is called (a cold start), /predict answers at once. */
  const coldService = () => {
    const calls = [];
    let release;
    const health = new Promise((r) => { release = () => r(json(200, { status: 'ok', modelVersion: 'fg-xgb-test' })); });
    const fetchImpl = async (url) => {
      calls.push(url.endsWith('/health') ? 'health' : 'predict');
      return url.endsWith('/health') ? health : json(200, mlAnswer());
    };
    return { calls, fetchImpl, release: () => release() };
  };
  const make = (svc, clock) => createMlClient({
    url: 'https://ml.example.com', apiKey: KEY, timeoutMs: 2500, cooldownMs: 60_000,
    fetchImpl: svc.fetchImpl, now: () => clock.t, logger: { warn() {}, error() {} },
  });

  it('wakeUpIfIdle starts one wake-up when nothing was heard for 10 minutes, none while it runs', async () => {
    const svc = coldService();
    const clock = { t: 1_000_000 };
    const c = make(svc, clock);
    expect(c.wakeUpIfIdle()).toBe(true);
    expect(c.wakeUpIfIdle()).toBe(true);              // already running: no second request
    expect(svc.calls).toEqual(['health']);
    expect(c.status().waking).toBe(true);
    svc.release();
    await c.wakeUp();                                 // the same in-flight promise
    expect(c.status()).toMatchObject({ waking: false, modelVersion: 'fg-xgb-test' });
    clock.t += 9 * 60_000;
    expect(c.wakeUpIfIdle()).toBe(false);             // answered 9 minutes ago: awake
    clock.t += 2 * 60_000;
    expect(c.wakeUpIfIdle()).toBe(true);              // 11 minutes: may be asleep again
  });

  it('a successful prediction also counts as contact', async () => {
    const svc = coldService();
    const clock = { t: 5_000_000 };
    const c = make(svc, clock);
    await c.predict(build());
    expect(c.wakeUpIfIdle()).toBe(false);
    expect(svc.calls).toEqual(['predict']);
  });

  it('while a cold start is running (> 2 s, no answer yet) a payment skips straight to the rules', async () => {
    const svc = coldService();
    const clock = { t: 9_000_000 };
    const c = make(svc, clock);
    c.wakeUpIfIdle();
    clock.t += 2_500;                                 // /health still pending after 2.5 s: a cold start
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'COOLDOWN' });
    expect(svc.calls).toEqual(['health']);            // no /predict request was sent into the cold start
    svc.release();
    await c.wakeUp();
    await expect(c.predict(build())).resolves.toMatchObject({ fraudScore: 88 });
  });

  it('a payment within the first 2 s of a wake-up is still sent (a warm service answers /health at once)', async () => {
    const svc = coldService();
    const clock = { t: 9_000_000 };
    const c = make(svc, clock);
    c.wakeUpIfIdle();
    clock.t += 500;
    await expect(c.predict(build())).resolves.toMatchObject({ fraudScore: 88 });
    clock.t += 5_000;                                 // the service answered a payment since the wake-up began
    await expect(c.predict(build())).resolves.toMatchObject({ fraudScore: 88 });
  });
});

describe('ML labels format like the ML reasons (E-05)', () => {
  it('ratios: one decimal, Indian grouping', () => {
    expect(ML_FEATURE_LABELS.amountToAvgRatio.format(21.74)).toBe('21.7×');
    expect(ML_FEATURE_LABELS.amountToMaxRatio.format(543478.26)).toBe('5,43,478.3×');
    expect(ML_FEATURE_LABELS.amount.format(150000)).toBe('₹1,50,000');
  });
});

describe('ML latency in the scoring block (R4-04)', () => {
  const tx = { ...TXN };
  it('an ML answer records the round trip; a skipped call (COOLDOWN) records none', async () => {
    const answered = { predict: jest.fn(async () => parsePrediction(mlAnswer({ fraudScore: 2 }))), wakeUp: jest.fn(), status: jest.fn() };
    const out = await scoreTransaction({ transaction: tx, behaviorProfile: null, deviceReputation: null, thresholds: null, mlClient: answered });
    expect(out.scoring.mlLatencyMs).toEqual(expect.any(Number));
    expect(out.scoring.mlLatencyMs).toBeGreaterThanOrEqual(0);
    const skipped = { predict: jest.fn(async () => { throw new MlScoringError('COOLDOWN', 'x'); }), wakeUp: jest.fn(), status: jest.fn() };
    const out2 = await scoreTransaction({ transaction: tx, behaviorProfile: null, deviceReputation: null, thresholds: null, mlClient: skipped });
    expect(out2.scoring).toEqual({ engine: 'RULES', ruleScore: out2.fraudScore, fallbackReason: 'COOLDOWN' });
  });
});
