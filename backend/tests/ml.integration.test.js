// tests/ml.integration.test.js — Phase 10: the ML engine inside the real submit pipeline (database + a fake
// ML service over HTTP). Calls processTransaction directly and signs session cookies itself, so it does not
// depend on the login route.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin } from './helpers/seedUser.js';
import { seedConfig } from './helpers/seedConfig.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { startFakeMlService, mlAnswer, FAKE_ML_KEY } from './helpers/fakeMlService.js';
import { processTransaction, buildTransactionResponse } from '../services/transactionService.js';
import { setMlClientForTests } from '../services/scoringService.js';
import { createMlClient } from '../services/mlClient.js';
import { checkFraud } from '../services/fraudDetectionService.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import app from '../app.js';

let fake;

beforeAll(async () => {
  await connectTestDB();
  fake = await startFakeMlService();
});
afterAll(async () => {
  setMlClientForTests(undefined); // back to "read the environment"
  await fake.close();
  await disconnectTestDB();
});
beforeEach(async () => {
  await clearCollections();
  await seedConfig();
  fake.requests.length = 0;
  fake.respondWith(() => ({ status: 200, body: mlAnswer() }));
  setMlClientForTests(createMlClient({ url: fake.url, apiKey: FAKE_ML_KEY, timeoutMs: 500, cooldownMs: 0, logger: { warn() {}, error() {} } }));
});

const payload = (o = {}) => ({
  amount: 9000,
  merchantName: 'Gadget Hub',
  merchantCategory: 'ELECTRONICS',
  paymentMethod: 'UPI',
  location: { city: 'Mumbai', country: 'IN' },
  deviceId: 'dev-ml-1',
  ...o,
});

const submit = async (user, o = {}, idempotencyKey) =>
  processTransaction({ user, payload: { ...payload(o), ...(idempotencyKey ? { idempotencyKey } : {}) }, context: { ip: '203.0.113.7' } });

/** A supertest request carrying a freshly signed session cookie for `user` (same token shape as CommonAPI). */
const asUser = (user) => {
  const token = jwt.sign({ id: user._id, iatMs: Date.now() }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return {
    get: (url) => supertest(app).get(url).set('Cookie', `token=${token}`),
    post: (url) => supertest(app).post(url).set('Cookie', `token=${token}`).set('Origin', process.env.FRONTEND_URL),
  };
};

describe('ML engine in processTransaction', () => {
  it('ML score decides the payment; SHAP values, engine and rule score are stored', async () => {
    const { user } = await seedUser();
    const { transaction, alert } = await submit(user);

    expect(transaction).toMatchObject({ fraudScore: 88, riskLevel: 'CRITICAL', recommendedAction: 'BLOCK', status: 'BLOCKED', estimatedLoss: 9000 });
    const stored = await TransactionModel.findById(transaction._id).lean();
    expect(stored.scoring).toMatchObject({ engine: 'ML', modelVersion: 'fg-xgb-test', fraudProbability: 0.88, shapBaseValue: -5.5 });
    expect(stored.scoring.fallbackReason).toBeUndefined();
    expect(stored.scoring.shapValues).toHaveLength(15);
    expect(stored.scoring.shapValues[0]).toEqual({ feature: 'isNewDevice', label: 'New device for this customer', value: 'Yes', shap: 3.2 });
    expect(stored.reasons).toEqual(mlAnswer().reasons);

    // the rule engine's opinion is kept for comparison, and the breakdown is still its six rules
    const rules = checkFraud({
      transaction: { ...payload(), timestamp: stored.timestamp },
      behaviorProfile: { transactionVelocity: { perHour: 0, perDay: 0 } },
      deviceReputation: null,
      thresholds: null,
    });
    expect(stored.scoring.ruleScore).toBe(rules.fraudScore);
    expect(stored.scoreBreakdown).toHaveLength(6);

    // alert: engine mirrored; two different signals → COMPOSITE
    expect(alert).toBeTruthy();
    const storedAlert = await FraudAlertModel.findById(alert._id).lean();
    expect(storedAlert).toMatchObject({ scoringEngine: 'ML', modelVersion: 'fg-xgb-test', alertType: 'COMPOSITE', fraudScore: 88, riskLevel: 'CRITICAL' });

    // the service received this payment's features — a brand-new customer has no profile yet
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].body.features).toMatchObject({ hasProfile: 0, isNewDevice: 0, amount: 9000, amountToAvgRatio: 1, paymentMethod: 'UPI' });
  });

  it('one ML reason feature → that alert type', async () => {
    fake.respondWith(() => ({ body: mlAnswer({ fraudScore: 55, reasons: ['Payment from a city the customer does not usually use'], reasonFeatures: ['isNewCity'] }) }));
    const { user } = await seedUser();
    const { alert } = await submit(user);
    expect((await FraudAlertModel.findById(alert._id).lean())).toMatchObject({ alertType: 'LOCATION_DEVIATION', riskLevel: 'HIGH' });
  });

  it('a LOW ML score approves and teaches the profile, which the next payment sends to the model', async () => {
    fake.respondWith(() => ({ body: mlAnswer({ fraudScore: 2, reasons: [], reasonFeatures: [] }) }));
    const { user } = await seedUser();
    const first = await submit(user, { amount: 1000 });
    expect(first.transaction).toMatchObject({ riskLevel: 'LOW', status: 'APPROVED' });
    expect(first.alert).toBeNull();
    expect(await BehaviorProfileModel.findOne({ userId: user._id }).lean()).toMatchObject({ avgTransactionAmount: 1000, knownDeviceIds: ['dev-ml-1'] });

    await submit(user, { amount: 4000, deviceId: 'dev-ml-2', location: { city: 'Delhi' } });
    expect(fake.requests[1].body.features).toMatchObject({
      hasProfile: 1, amountToAvgRatio: 4, amountToMaxRatio: 4, isNewDevice: 1, isNewCity: 1, txnsLastHour: 1, txnsLastDay: 1,
    });
  });

  it('the admin bands apply to the ML score', async () => {
    await seedConfig({ scoreThresholds: { mediumMin: 10, highMin: 20, criticalMin: 95 } });
    fake.respondWith(() => ({ body: mlAnswer({ fraudScore: 88 }) }));
    const { user } = await seedUser();
    const { transaction } = await submit(user);
    expect(transaction).toMatchObject({ fraudScore: 88, riskLevel: 'HIGH', status: 'HELD', estimatedLoss: 6300 });
  });

  it('ML too slow → the rule engine decides and the reason is stored', async () => {
    fake.respondWith(() => ({ delayMs: 1500, body: mlAnswer() }));
    const { user } = await seedUser();
    const { transaction } = await submit(user);
    const stored = await TransactionModel.findById(transaction._id).lean();
    expect(stored.scoring).toEqual({ engine: 'RULES', ruleScore: stored.fraudScore, fallbackReason: 'TIMEOUT', mlLatencyMs: expect.any(Number) });
    expect(stored.scoring.mlLatencyMs).toBeGreaterThanOrEqual(450); // R4-04: the payment waited about ML_TIMEOUT_MS (500 here)
    expect(stored.fraudScore).toBe(stored.scoreBreakdown.reduce((sum, r) => sum + r.points, 0));
  });

  it('ML disabled → rules, engine RULES, no fallback reason, no HTTP call', async () => {
    setMlClientForTests(null);
    const { user } = await seedUser();
    const { transaction } = await submit(user);
    expect((await TransactionModel.findById(transaction._id).lean()).scoring).toEqual({ engine: 'RULES', ruleScore: transaction.fraudScore });
    expect(fake.requests).toHaveLength(0);
  });

  it('an idempotent replay returns the stored ML result without asking the model again', async () => {
    const { user } = await seedUser();
    const first = await submit(user, {}, 'key-ml-1');
    const replay = await submit(user, { amount: 1 }, 'key-ml-1');
    expect(replay.replayed).toBe(true);
    expect(String(replay.transaction._id)).toBe(String(first.transaction._id));
    expect(replay.fraud.scoring).toMatchObject({ engine: 'ML', modelVersion: 'fg-xgb-test' });
    expect(fake.requests).toHaveLength(1);
  });

  it('a replay that recreates a missing alert classifies it from the ML signals', async () => {
    fake.respondWith(() => ({ body: mlAnswer({ fraudScore: 80, reasons: ['Payment from a device the customer has not used before'], reasonFeatures: ['isNewDevice'] }) }));
    const { user } = await seedUser();
    const first = await submit(user, {}, 'key-ml-2');
    await FraudAlertModel.deleteMany({});
    const replay = await submit(user, {}, 'key-ml-2');
    expect(replay.alert).toBeTruthy();
    expect(await FraudAlertModel.findById(replay.alert._id).lean()).toMatchObject({ alertType: 'NEW_DEVICE', scoringEngine: 'ML', transactionId: first.transaction._id });
  });

  it('the HTTP response carries the scoring block (null for legacy transactions)', async () => {
    const { user } = await seedUser();
    const { transaction, alert } = await submit(user);
    const response = JSON.parse(JSON.stringify(buildTransactionResponse(transaction, alert)));
    expect(response.scoring).toMatchObject({ engine: 'ML', ruleScore: expect.any(Number), modelVersion: 'fg-xgb-test' });
    expect(response.scoring.shapValues).toHaveLength(15);
    expect(Object.keys(response.scoring.shapValues[0])).toEqual(['feature', 'label', 'value', 'shap']);

    const legacy = await seedTransaction({ userId: user._id });
    expect(buildTransactionResponse(legacy, null).scoring).toBeNull();
  });
});

describe('rule floor and request id in the real pipeline', () => {
  it('a casino payment the model rates 0 is stored as MEDIUM (approved, alert) with ruleFloor and mlScore', async () => {
    fake.respondWith(() => ({ body: mlAnswer({ fraudScore: 0, fraudProbability: 0.002, reasons: [], reasonFeatures: [], top: { amount: -0.3 } }) }));
    const { user } = await seedUser();
    const { transaction, alert } = await submit(user, { merchantCategory: 'CASINO', merchantName: 'Lucky Star' });

    expect(transaction).toMatchObject({ fraudScore: 35, riskLevel: 'MEDIUM', recommendedAction: 'OTP', status: 'APPROVED' });
    expect(transaction.reasons).toEqual(['High-risk merchant category detected: CASINO']);
    const stored = await TransactionModel.findById(transaction._id).lean();
    expect(stored.scoring).toMatchObject({ engine: 'ML', mlScore: 0, ruleScore: 35, ruleFloor: true, signals: ['HIGH_RISK_MERCHANT'] });
    expect(await FraudAlertModel.findById(alert._id).lean()).toMatchObject({ alertType: 'HIGH_RISK_MERCHANT', riskLevel: 'MEDIUM', scoringEngine: 'ML' });
    // returned to the client with the new fields
    expect(buildTransactionResponse(transaction, alert).scoring).toMatchObject({ mlScore: 0, ruleFloor: true });
  });

  it('the X-Request-Id sent to the ML service is kept in the TRANSACTION_SUBMITTED audit entry (E-06)', async () => {
    const { user } = await seedUser();
    const { transaction } = await submit(user);
    const sentId = fake.requests[0].headers['x-request-id'];
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
    const entry = await AuditLogModel.findOne({ action: 'TRANSACTION_SUBMITTED', entityId: transaction.publicId }).lean();
    expect(entry.metadata).toMatchObject({ scoringEngine: 'ML', scoringRequestId: sentId });
  });
});

describe('GET /admin-api/ml-status', () => {
  it('admin sees the engine state and how the last 24 hours were scored; no secrets', async () => {
    const { user } = await seedUser();
    await submit(user);                                   // ML
    setMlClientForTests(null);
    await submit(user, { deviceId: 'dev-other' });        // RULES
    await seedTransaction({ userId: user._id });          // legacy (no scoring)
    setMlClientForTests(createMlClient({ url: fake.url, apiKey: FAKE_ML_KEY, timeoutMs: 500, cooldownMs: 0 }));

    const { user: admin } = await seedAdmin();
    const res = await asUser(admin).get('/admin-api/ml-status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, serviceHost: new URL(fake.url).host, timeoutMs: expect.any(Number), last24h: { ML: 1, RULES: 1, LEGACY: 1 } });
    expect(JSON.stringify(res.body)).not.toContain(FAKE_ML_KEY);
  });

  it('reports ML as disabled when it is off; customers are refused', async () => {
    setMlClientForTests(null);
    const { user: admin } = await seedAdmin();
    const res = await asUser(admin).get('/admin-api/ml-status');
    expect(res.body.data).toMatchObject({ enabled: false, serviceHost: null, coolingDown: false, last24h: { ML: 0, RULES: 0, LEGACY: 0 } });

    const { user } = await seedUser();
    expect((await asUser(user).get('/admin-api/ml-status')).status).toBe(403);
  });

  it('customers get the scoring block on their transaction detail', async () => {
    const { user } = await seedUser();
    const { transaction } = await submit(user);
    const res = await asUser(user).get(`/customer-api/transactions/${transaction._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.transaction.scoring).toMatchObject({ engine: 'ML', shapValues: expect.any(Array) });
  });
});

describe('ML wake-up on visits (D-2)', () => {
  it('POST /customer-api/ml-warm-up starts a wake-up once, answers at once (202)', async () => {
    const client = createMlClient({ url: fake.url, apiKey: FAKE_ML_KEY, timeoutMs: 500, cooldownMs: 0 });
    setMlClientForTests(client);
    const { user } = await seedUser();
    const first = await asUser(user).post('/customer-api/ml-warm-up');
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual({ mlEnabled: true, warming: true });
    await client.wakeUp();                                     // let the background /health finish
    expect(client.status()).toMatchObject({ waking: false, modelVersion: 'fg-xgb-test' });
    const again = await asUser(user).post('/customer-api/ml-warm-up');
    expect(again.body.data).toEqual({ mlEnabled: true, warming: false }); // answered just now: nothing to do
  });

  it('with ML off it does nothing; only customers may call it', async () => {
    setMlClientForTests(null);
    const { user } = await seedUser();
    const res = await asUser(user).post('/customer-api/ml-warm-up');
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ mlEnabled: false, warming: false });
    const { user: admin } = await seedAdmin();
    expect((await asUser(admin).post('/customer-api/ml-warm-up')).status).toBe(403);
  });

  it('opening the admin dashboard (GET /admin-api/ml-status) wakes an idle ML service', async () => {
    const client = createMlClient({ url: fake.url, apiKey: FAKE_ML_KEY, timeoutMs: 500, cooldownMs: 0 });
    setMlClientForTests(client);
    const { user: admin } = await seedAdmin();
    expect(client.status().modelVersion).toBeNull();          // never contacted yet
    const res = await asUser(admin).get('/admin-api/ml-status');
    expect(res.body.data.enabled).toBe(true);
    // the wake-up started by the request is either still running or already answered (fast local fake)
    expect(res.body.data.waking || res.body.data.modelVersion === 'fg-xgb-test').toBe(true);
    await client.wakeUp();
    expect(client.status().modelVersion).toBe('fg-xgb-test');
  });
});
