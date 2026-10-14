// tests/ml.units.test.js — Phase 10 ML integration: settings, feature builder, client, scoring (no database).
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getMlSettings, validateMlSettings, DEFAULT_ML_TIMEOUT_MS, DEFAULT_ML_COOLDOWN_MS } from '../config/mlSettings.js';
import { buildMlFeatures, ML_FEATURE_LABELS, ML_FEATURE_ALERT_TYPES } from '../services/mlFeatureBuilder.js';
import { createMlClient, parsePrediction, MlScoringError } from '../services/mlClient.js';
import { scoreTransaction, signalsFromReasonFeatures, GENERIC_ML_REASON } from '../services/scoringService.js';
import { checkFraud, decisionForScore, resolveThresholds } from '../services/fraudDetectionService.js';
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

  it('cool-down expires after ML_COOLDOWN_MS', async () => {
    let now = 0;
    fake.respondWith(() => ({ status: 500, body: {} }));
    const c = client({ now: () => now, cooldownMs: 10_000 });
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    now = 9_999;
    await expect(c.predict(build())).rejects.toMatchObject({ code: 'COOLDOWN' });
    now = 10_000;
    fake.respondWith(() => ({ status: 200, body: mlAnswer() }));
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
    expect(out).toEqual({ ...rules, scoring: { engine: 'RULES', ruleScore: rules.fraudScore, fallbackReason: 'TIMEOUT' } });
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
    expect(risky.signals).toEqual([]);
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
