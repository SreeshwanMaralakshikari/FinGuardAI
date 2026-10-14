// tests/round2a.api.test.js — fix round 2a (backend)
//   A-09 transactionService · C-01 idempotency · B-01 breakdown persisted · B-02/B-03/B-04 case outcomes ·
//   B-06 thresholds · A-03 analyst notifications · A-09 read audit · C-07 counts · E-20/T-03 concurrency
import { beforeAll, afterAll, beforeEach, describe, it, expect, jest } from '@jest/globals';
import supertest from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import { itAtomic } from './helpers/dbAtomicity.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAnalyst, seedAdmin, uniqueEmail } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import NotificationModel from '../models/NotificationModel.js';
import UserModel from '../models/UserModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import { processTransaction } from '../services/transactionService.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import calcBehaviorProfile from '../utils/calcBehaviorProfile.js';
import updateTrustScore from '../utils/updateTrustScore.js';
import { countStatuses } from '../utils/statusCounts.js';
import { notifyAnalystsOfStatusChange, MAX_ANALYST_RECIPIENTS } from '../utils/caseWorkflow.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

const txn = (o = {}) => ({
  amount: 500, merchantName: 'BookStore', merchantCategory: 'RETAIL', paymentMethod: 'UPI',
  location: { city: 'Mumbai', country: 'IN' }, deviceId: 'dev-safe', ...o,
});
const highRisk = txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'CARD', deviceId: 'dev-x' });
const post = (agent, body, key) => {
  const req = agent.post('/customer-api/transactions');
  return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
};

async function customer(prefix = 'c') {
  const { user, password } = await seedUser({ email: uniqueEmail(prefix) });
  return { user, agent: await loginAgent(user.email, password) };
}
async function analystAgent(name = 'Alice Analyst') {
  const { user, password } = await seedAnalyst({ email: uniqueEmail('an'), name });
  return { user, agent: await loginAgent(user.email, password) };
}
const patchStatus = (agent, caseId, body) => agent.patch(`/analyst-api/cases/${caseId}/status`).send(body);
const assign = (agent, caseId) => agent.patch(`/analyst-api/cases/${caseId}/assign`).send({});

/** A customer with one HELD transaction + alert, an analyst, and optionally the opened case. */
async function workflow({ withCase = true } = {}) {
  const c = await customer('wfc');
  const submitted = await post(c.agent, highRisk);
  const a = await analystAgent();
  const transaction = await TransactionModel.findById(submitted.body.data.id);
  const alertId = submitted.body.data.fraudAlert.id;
  const out = { customer: c.agent, customerUser: c.user, analyst: a.agent, analystUser: a.user, transaction, alertId, submitted };
  if (withCase) out.caseId = (await a.agent.post('/analyst-api/cases').send({ fraudAlertId: alertId })).body.data._id;
  return out;
}

// ── A-09: the service works without Express ─────────────────────────────────────────────────────────
describe('A-09 transactionService', () => {
  it('processTransaction({ user, payload, context }) needs no request: stores, scores, alerts, audits', async () => {
    const { user } = await seedUser({ email: uniqueEmail('svc') });
    const result = await processTransaction({ user, payload: highRisk, context: { ip: '203.0.113.9' } });
    expect(result.replayed).toBe(false);
    expect(result.transaction.publicId).toMatch(/^TXN-\d{4}-\d{5}$/);
    expect(result.transaction.status).toBe('HELD');
    expect(result.fraud).toMatchObject({ riskLevel: 'HIGH', fraudScore: 55, rawScore: 55 });
    expect(result.alert.transactionId.toString()).toBe(result.transaction._id.toString());
    expect(result.transaction.ipAddress).toBe('203.0.113.9');
    expect(await AuditLogModel.countDocuments({ action: { $in: ['TRANSACTION_SUBMITTED', 'FRAUD_ALERT_CREATED'] } })).toBe(2);
    expect(await NotificationModel.countDocuments({ recipientId: user._id })).toBe(1);
    expect((await UserModel.findById(user._id)).trustScore).toBe(50); // (0 + 0.5 + 1) / (1 + 2)
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'dev-x' })).toBe(1);
  });

  it('the HTTP response keeps its shape (201, flat data) and gains only scoreBreakdown (+ scoring, Phase 10)', async () => {
    const { agent } = await customer();
    const res = await post(agent, txn());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['success', 'message', 'data']);
    expect(res.body.message).toBe('Transaction submitted successfully.');
    expect(Object.keys(res.body.data)).toEqual(['id', 'publicId', 'amount', 'merchantName', 'merchantCategory', 'paymentMethod', 'fraudScore',
      'riskLevel', 'reasons', 'recommendedAction', 'estimatedLoss', 'status', 'fraudAlert', 'timestamp', 'scoreBreakdown', 'scoring']);
    expect(res.body.data.scoring).toEqual({ engine: 'RULES', ruleScore: res.body.data.fraudScore }); // ML off in tests
    expect(res.body.replayed).toBeUndefined();
  });
});

// ── B-01: breakdown stored and returned ─────────────────────────────────────────────────────────────
describe('B-01 scoreBreakdown is persisted and returned', () => {
  it('submit response, stored document, history, detail and analyst detail all carry the six rules', async () => {
    const { agent } = await customer();
    const res = await post(agent, highRisk);
    const { scoreBreakdown, fraudScore } = res.body.data;
    expect(scoreBreakdown.map((b) => b.rule)).toEqual(['velocity', 'amount', 'location', 'device', 'time', 'merchant']);
    expect(scoreBreakdown.reduce((s, b) => s + b.points, 0)).toBe(fraudScore);
    expect(scoreBreakdown.find((b) => b.rule === 'merchant')).toMatchObject({ points: 35, max: 35 });

    const stored = await TransactionModel.findById(res.body.data.id).lean();
    expect(stored.scoreBreakdown).toHaveLength(6);
    expect(Object.keys(stored.scoreBreakdown[0]).sort()).toEqual(['label', 'max', 'points', 'rule']);

    const history = await agent.get('/customer-api/transactions');
    expect(history.body.data[0].scoreBreakdown).toEqual(scoreBreakdown);
    const detail = await agent.get(`/customer-api/transactions/${res.body.data.id}`);
    expect(detail.body.data.transaction.scoreBreakdown).toEqual(scoreBreakdown);

    const { agent: an } = await analystAgent();
    const flagged = await an.get(`/analyst-api/flagged-transactions/${res.body.data.id}`);
    expect(flagged.body.data.transaction.scoreBreakdown).toEqual(scoreBreakdown);
  });

  it('legacy transactions without a breakdown read as []', async () => {
    const { user, agent } = await customer();
    const old = await seedTransaction({ userId: user._id });
    expect((await agent.get(`/customer-api/transactions/${old._id}`)).body.data.transaction.scoreBreakdown).toEqual([]);
  });
});

// ── C-01: idempotency ───────────────────────────────────────────────────────────────────────────────
describe('C-01 Idempotency-Key', () => {
  const KEY = 'order-2026-0001';

  it('a replay returns the ORIGINAL result (200, replayed:true) and writes nothing', async () => {
    const { agent } = await customer();
    const first = await post(agent, highRisk, KEY);
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBeUndefined();
    const counts = async () => [
      await TransactionModel.countDocuments({}), await FraudAlertModel.countDocuments({}),
      await NotificationModel.countDocuments({}), await AuditLogModel.countDocuments({ action: { $in: ['TRANSACTION_SUBMITTED', 'FRAUD_ALERT_CREATED'] } }),
    ];
    const before = await counts();

    const again = await post(agent, highRisk, KEY);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.success).toBe(true);
    expect(again.body.data).toEqual(first.body.data); // same ids, score, breakdown, alert id, timestamp
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.publicId).toBe(first.body.data.publicId);
    expect(again.body.data.fraudAlert.id).toBe(first.body.data.fraudAlert.id);
    expect(await counts()).toEqual(before);
  });

  it('a LOW payment replays too (no alert)', async () => {
    const { agent } = await customer();
    const first = await post(agent, txn(), KEY);
    const again = await post(agent, txn(), KEY);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.data).toEqual(first.body.data);
    expect(again.body.data.fraudAlert).toBeNull();
  });

  it('a DIFFERENT payload with the same key still returns the original (the key, not the body, identifies the payment)', async () => {
    const { user, agent } = await customer();
    const first = await post(agent, txn({ amount: 100 }), KEY);
    const again = await post(agent, txn({ amount: 999, merchantName: 'Other Shop' }), KEY);
    expect(again.status).toBe(200);
    expect(again.body.data.amount).toBe(100);
    expect(again.body.data.merchantName).toBe('BookStore');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  it('different users may reuse the same key', async () => {
    const a = await customer('ka');
    const b = await customer('kb');
    const ra = await post(a.agent, txn(), KEY);
    const rb = await post(b.agent, txn({ deviceId: 'dev-b' }), KEY);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ra.body.data.id).not.toBe(rb.body.data.id);
    expect(await TransactionModel.countDocuments({})).toBe(2);
  });

  it('different keys create different transactions; no header = no idempotency', async () => {
    const { agent } = await customer();
    expect((await post(agent, txn(), 'key-number-1')).status).toBe(201);
    expect((await post(agent, txn(), 'key-number-2')).status).toBe(201);
    expect((await post(agent, txn())).status).toBe(201);
    expect((await post(agent, txn())).status).toBe(201);
    expect(await TransactionModel.countDocuments({})).toBe(4);
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'k'.repeat(101)],
    ['space', 'has space in it'],
    ['symbol', 'bad.key!1234'],
    ['unicode', 'schlüssel-12345'],
    ['empty', ''],
  ])('an invalid key (%s) is 422 and nothing is stored', async (_label, key) => {
    const { user, agent } = await customer();
    const res = await post(agent, txn(), key);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Idempotency-Key/);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(0);
  });

  it('the boundary lengths 8 and 100 (and _ -) are accepted', async () => {
    const { agent } = await customer();
    expect((await post(agent, txn(), 'ab_-1234')).status).toBe(201);
    expect((await post(agent, txn(), 'Z'.repeat(100))).status).toBe(201);
  });

  it('simultaneous requests with one key create ONE transaction (the per-user lock)', async () => {
    const { user, agent } = await customer();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(agent, highRisk, KEY)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.replayed === true)).toHaveLength(5);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(1);
    expect(await FraudAlertModel.countDocuments({ userId: user._id })).toBe(1);
    expect(await NotificationModel.countDocuments({ recipientId: user._id })).toBe(1);
  });

  it('the key is never returned by the API', async () => {
    const { agent } = await customer();
    const res = await post(agent, txn(), KEY);
    const history = await agent.get('/customer-api/transactions');
    const detail = await agent.get(`/customer-api/transactions/${res.body.data.id}`);
    expect(JSON.stringify([res.body, history.body, detail.body])).not.toContain(KEY);
    expect((await TransactionModel.findById(res.body.data.id).select('+idempotencyKey').lean()).idempotencyKey).toBe(KEY); // …but it is stored
  });

  it('backstop: when the insert loses a unique-index race the winner is returned', async () => {
    const { user, agent } = await customer();
    const first = await post(agent, txn(), KEY);
    // the pre-check "misses" (another instance had not committed yet) …
    const findSpy = jest.spyOn(TransactionModel, 'findOne').mockImplementationOnce(() => Promise.resolve(null));
    // … and the insert is refused by the unique (userId, idempotencyKey) index
    const createSpy = jest.spyOn(TransactionModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { userId: 1, idempotencyKey: 1 } })
    );
    const again = await post(agent, txn(), KEY);
    findSpy.mockRestore(); createSpy.mockRestore();
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(1);
  });

  itAtomic('the unique partial index {userId, idempotencyKey} rejects a duplicate but ignores documents without a key', async () => {
    const { user } = await customer();
    const base = { userId: user._id, amount: 1, merchantName: 'M', paymentMethod: 'UPI', deviceId: 'd', fraudScore: 0, riskLevel: 'LOW', recommendedAction: 'APPROVE', status: 'APPROVED' };
    await TransactionModel.create({ ...base, idempotencyKey: 'abcdefgh1' });
    await expect(TransactionModel.create({ ...base, idempotencyKey: 'abcdefgh1' })).rejects.toMatchObject({ code: 11000 });
    await TransactionModel.create({ ...base, idempotencyKey: 'abcdefgh2' });
    await TransactionModel.create(base);
    await TransactionModel.create(base);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(4);
  });

  it('the schema declares the partial unique index and a select:false field', () => {
    const idx = TransactionModel.schema.indexes().find(([fields]) => fields.idempotencyKey === 1);
    expect(idx[0]).toEqual({ userId: 1, idempotencyKey: 1 });
    expect(idx[1]).toMatchObject({ unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } } });
    expect(TransactionModel.schema.path('idempotencyKey').options.select).toBe(false);
  });

  it('CORS preflight allows the Idempotency-Key header', async () => {
    const res = await supertest(app).options('/customer-api/transactions')
      .set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,idempotency-key');
    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('idempotency-key');
  });
});

// ── B-02 / B-03 / B-04: case outcomes ───────────────────────────────────────────────────────────────
describe('B-04 alert status follows the case', () => {
  it('stays OPEN at case creation and while UNDER_REVIEW; REVIEWED on RESOLVED; DISMISSED on DISMISSED', async () => {
    const w = await workflow();
    const alertStatus = async () => (await FraudAlertModel.findById(w.alertId)).status;
    expect(await alertStatus()).toBe('OPEN');
    await assign(w.analyst, w.caseId);
    expect(await alertStatus()).toBe('OPEN');
    await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    expect(await alertStatus()).toBe('OPEN');
    // customer view and filter agree
    expect((await w.customer.get('/customer-api/fraud-alerts?status=OPEN')).body.data).toHaveLength(1);
    await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'real' });
    expect(await alertStatus()).toBe('REVIEWED');
    expect((await w.customer.get('/customer-api/fraud-alerts?status=OPEN')).body.data).toHaveLength(0);
    expect((await w.customer.get('/customer-api/fraud-alerts?status=REVIEWED')).body.data).toHaveLength(1);

    const w2 = await workflow();
    await assign(w2.analyst, w2.caseId);
    await patchStatus(w2.analyst, w2.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    expect((await FraudAlertModel.findById(w2.alertId)).status).toBe('DISMISSED');
  });

  it('the duplicate-case guard does not depend on the alert status', async () => {
    const w = await workflow();
    expect((await w.analyst.post('/analyst-api/cases').send({ fraudAlertId: w.alertId })).status).toBe(400);
    expect(await FraudCaseModel.countDocuments({})).toBe(1);
  });

  it('the audit entry of the alert records OPEN → REVIEWED at close time', async () => {
    const w = await workflow();
    await assign(w.analyst, w.caseId);
    await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    expect((await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'real' })).status).toBe(200);
    const entry = await AuditLogModel.findOne({ action: 'FRAUD_ALERT_STATUS_CHANGED' });
    expect(entry.metadata).toMatchObject({ previousStatus: 'OPEN', newStatus: 'REVIEWED' });
  });
});

describe('B-02 RESOLVED = fraud confirmed', () => {
  it('HELD → BLOCKED; trust score and device score recalculated; counters NOT double counted', async () => {
    const w = await workflow();
    const device = () => DeviceReputationModel.findOne({ deviceId: w.transaction.deviceId }).lean();
    const before = await device();
    const trustBefore = (await UserModel.findById(w.customerUser._id)).trustScore;
    expect(before).toMatchObject({ reputationScore: 88, flagCount: 1, fraudTransactionCount: 1 }); // 1 HELD: (0.5 + 3) / (1 + 3)
    expect(trustBefore).toBe(50);

    await assign(w.analyst, w.caseId);
    await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    const res = await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'Confirmed fraud' });
    expect(res.status).toBe(200);

    const stored = await TransactionModel.findById(w.transaction._id).lean();
    expect(stored.status).toBe('BLOCKED');
    expect(stored.releasedByCaseAt).toBeUndefined();
    expect((await UserModel.findById(w.customerUser._id)).trustScore).toBe(33); // (0 + 0 + 1) / (1 + 2): a BLOCKED payment earns no credit
    const after = await device();
    expect(after.reputationScore).toBe(75); // 3 / (1 + 3)
    expect(after.flagCount).toBe(before.flagCount);
    expect(after.fraudTransactionCount).toBe(before.fraudTransactionCount);
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());

    const audit = await AuditLogModel.findOne({ action: 'TRANSACTION_BLOCKED' });
    expect(audit).toMatchObject({ actorRole: 'ANALYST', entityType: 'Transaction', entityId: w.transaction.publicId });
    expect(audit.metadata).toMatchObject({ previousStatus: 'HELD', newStatus: 'BLOCKED' });
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_RELEASED' })).toBe(0);

    const outcome = (await w.customer.get('/notification-api/notifications')).body.data[0];
    expect(outcome).toMatchObject({ type: 'FRAUD_ALERT', title: 'Fraud Confirmed', relatedEntityType: 'FRAUD_ALERT' });
    expect(outcome.message).toContain(w.transaction.publicId);
    expect(outcome.message).toMatch(/confirmed it as fraudulent\. The payment has been blocked\./);
    expect(outcome.message).not.toMatch(/Confirmed fraud/); // the analyst's internal summary stays internal
    // the customer sees BLOCKED in history and in the alert list
    expect((await w.customer.get('/customer-api/transactions')).body.data[0].status).toBe('BLOCKED');
    expect((await w.customer.get('/customer-api/fraud-alerts')).body.data[0].transactionId.status).toBe('BLOCKED');
  });

  it('an already BLOCKED transaction stays BLOCKED (no audit, no recalculation noise); APPROVED (legacy MEDIUM) is left alone', async () => {
    const w = await workflow({ withCase: false });
    const owner = (await seedUser({ email: uniqueEmail('owner') })).user;
    const resolveOne = async (status, riskLevel) => {
      const transaction = await seedTransaction({ userId: owner._id, status, riskLevel, fraudScore: 80, recommendedAction: 'BLOCK', deviceId: `dev-${Math.random()}` });
      const alert = await FraudAlertModel.create({ transactionId: transaction._id, userId: owner._id, alertType: 'COMPOSITE', riskLevel, fraudScore: 80, reasons: [] });
      const fraudCase = await createWithSequentialId(FraudCaseModel, 'publicId', 'CASE', { fraudAlertId: alert._id, transactionId: transaction._id, status: 'OPEN' });
      await assign(w.analyst, fraudCase._id);
      await patchStatus(w.analyst, fraudCase._id, { status: 'UNDER_REVIEW' });
      expect((await patchStatus(w.analyst, fraudCase._id, { status: 'RESOLVED', resolutionSummary: 'real' })).status).toBe(200);
      return { transaction, alert };
    };
    const blocked = await resolveOne('BLOCKED', 'CRITICAL');
    expect((await TransactionModel.findById(blocked.transaction._id)).status).toBe('BLOCKED');
    expect((await FraudAlertModel.findById(blocked.alert._id)).status).toBe('REVIEWED');
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_BLOCKED' })).toBe(0);
    const approved = await resolveOne('APPROVED', 'MEDIUM');
    expect((await TransactionModel.findById(approved.transaction._id)).status).toBe('APPROVED');
    const msgs = (await NotificationModel.find({ recipientId: owner._id }).sort({ createdAt: 1 })).map((n) => n.message);
    expect(msgs[0]).toMatch(/confirmed it as fraudulent\. The payment has been blocked\./); // it IS blocked
    expect(msgs[1]).toMatch(/confirmed it as fraudulent\. The alert has been closed\./);      // approved one: no false "blocked" claim
  });

  it('undo: if the transaction write fails the alert and the case are restored, nothing is audited, and a retry completes', async () => {
    const w = await workflow();
    await assign(w.analyst, w.caseId);
    await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    const spy = jest.spyOn(TransactionModel, 'updateOne').mockRejectedValueOnce(new Error('db hiccup'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'real fraud' });
    spy.mockRestore(); quiet.mockRestore();
    expect(failed.status).toBe(500);

    const reopened = await FraudCaseModel.findById(w.caseId);
    expect(reopened.status).toBe('UNDER_REVIEW');
    expect(reopened.resolvedAt ?? null).toBeNull();
    expect((await FraudAlertModel.findById(w.alertId)).status).toBe('OPEN');         // alert write rolled back
    expect((await TransactionModel.findById(w.transaction._id)).status).toBe('HELD');
    expect(await AuditLogModel.countDocuments({ action: { $in: ['FRAUD_ALERT_STATUS_CHANGED', 'TRANSACTION_BLOCKED', 'CASE_STATUS_CHANGED'] } })).toBe(1); // only the UNDER_REVIEW entry
    expect(await NotificationModel.countDocuments({ recipientId: w.transaction.userId })).toBe(1); // only the original alert notice

    const retry = await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'real fraud' });
    expect(retry.status).toBe(200);
    expect((await TransactionModel.findById(w.transaction._id)).status).toBe('BLOCKED');
    expect((await FraudAlertModel.findById(w.alertId)).status).toBe('REVIEWED');
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_BLOCKED' })).toBe(1);
    const device = await DeviceReputationModel.findOne({ deviceId: w.transaction.deviceId });
    expect(device).toMatchObject({ flagCount: 1, fraudTransactionCount: 1 }); // still counted once
  });

  it('undo also works when the ALERT write fails first (DISMISSED path): nothing changed, case reopened', async () => {
    const w = await workflow();
    await assign(w.analyst, w.caseId);
    const spy = jest.spyOn(TransactionModel, 'updateOne').mockRejectedValueOnce(new Error('db hiccup'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await patchStatus(w.analyst, w.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    spy.mockRestore(); quiet.mockRestore();
    expect(failed.status).toBe(500);
    expect((await FraudCaseModel.findById(w.caseId)).status).toBe('ASSIGNED');
    expect((await FraudAlertModel.findById(w.alertId)).status).toBe('OPEN');
    const stored = await TransactionModel.findById(w.transaction._id).lean();
    expect(stored.status).toBe('HELD');
    expect(stored.releasedByCaseAt).toBeUndefined();
    expect((await patchStatus(w.analyst, w.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' })).status).toBe(200);
  });
});

describe('B-03 DISMISSED teaches the behaviour profile', () => {
  /** Mumbai / dev-A history through the API, then a new-city / new-device payment that is HELD. */
  async function heldNewCityAndDevice() {
    const c = await customer('prof');
    for (const amount of [900, 1000, 1100]) {
      expect((await post(c.agent, txn({ amount, deviceId: 'dev-A' }))).body.data.riskLevel).toBe('LOW');
    }
    const odd = txn({ amount: 60000, merchantName: 'Gadget Hub', deviceId: 'dev-B', location: { city: 'Delhi', country: 'IN' } });
    const held = await post(c.agent, odd);
    expect(held.body.data).toMatchObject({ status: 'HELD', riskLevel: 'HIGH' });
    const a = await analystAgent();
    const created = await a.agent.post('/analyst-api/cases').send({ fraudAlertId: held.body.data.fraudAlert.id });
    return { ...c, analyst: a.agent, odd, held, caseId: created.body.data._id };
  }

  it('the released transaction is stamped, trains the profile, and the same payment is no longer flagged for city / device', async () => {
    const x = await heldNewCityAndDevice();
    const before = await BehaviorProfileModel.findOne({ userId: x.user._id }).lean();
    expect(before.knownDeviceIds).toEqual(['dev-A']);
    expect(before.usualLocations).toEqual(['Mumbai']);

    await assign(x.analyst, x.caseId);
    expect((await patchStatus(x.analyst, x.caseId, { status: 'DISMISSED', resolutionSummary: 'customer confirmed' })).status).toBe(200);

    const released = await TransactionModel.findById(x.held.body.data.id).lean();
    expect(released.status).toBe('APPROVED');
    expect(released.releasedByCaseAt).toBeInstanceOf(Date);
    const after = await BehaviorProfileModel.findOne({ userId: x.user._id }).lean();
    expect(after.knownDeviceIds.sort()).toEqual(['dev-A', 'dev-B']);
    expect(after.usualLocations.sort()).toEqual(['Delhi', 'Mumbai']);
    expect(after.maxTransactionAmount).toBe(60000);
    expect(after.avgTransactionAmount).toBe((900 + 1000 + 1100 + 60000) / 4);

    const again = await post(x.agent, x.odd);
    expect(again.body.data.reasons.join(' ')).not.toMatch(/unrecognised device|unusual city/);
    expect(again.body.data.riskLevel).not.toBe('HIGH');
  });

  it('calcBehaviorProfile counts APPROVED+LOW and released transactions; APPROVED MEDIUM, HELD and BLOCKED do not train', async () => {
    const { user } = await customer();
    const base = { userId: user._id };
    await seedTransaction({ ...base, amount: 100, deviceId: 'low', location: { city: 'Pune' } });
    await seedTransaction({ ...base, amount: 300, deviceId: 'rel', riskLevel: 'HIGH', status: 'APPROVED', releasedByCaseAt: new Date(), location: { city: 'Goa' } });
    await seedTransaction({ ...base, amount: 900, deviceId: 'med', riskLevel: 'MEDIUM', location: { city: 'Agra' } });
    await seedTransaction({ ...base, amount: 800, deviceId: 'held', riskLevel: 'HIGH', status: 'HELD', releasedByCaseAt: new Date() });
    await seedTransaction({ ...base, amount: 700, deviceId: 'blk', riskLevel: 'CRITICAL', status: 'BLOCKED' });
    const profile = await calcBehaviorProfile(user._id);
    expect(profile.avgTransactionAmount).toBe(200);
    expect(profile.maxTransactionAmount).toBe(300);
    expect(profile.knownDeviceIds.sort()).toEqual(['low', 'rel']);
    expect(profile.usualLocations.sort()).toEqual(['Goa', 'Pune']);
  });

  it('a dismissed MEDIUM transaction (already APPROVED, never held) does NOT train', async () => {
    const w = await workflow({ withCase: false });
    const owner = (await seedUser({ email: uniqueEmail('med') })).user;
    const transaction = await seedTransaction({ userId: owner._id, status: 'APPROVED', riskLevel: 'MEDIUM', fraudScore: 40, recommendedAction: 'OTP', deviceId: 'dev-med' });
    const alert = await FraudAlertModel.create({ transactionId: transaction._id, userId: owner._id, alertType: 'COMPOSITE', riskLevel: 'MEDIUM', fraudScore: 40, reasons: [] });
    const fraudCase = await createWithSequentialId(FraudCaseModel, 'publicId', 'CASE', { fraudAlertId: alert._id, transactionId: transaction._id, status: 'OPEN' });
    await assign(w.analyst, fraudCase._id);
    expect((await patchStatus(w.analyst, fraudCase._id, { status: 'DISMISSED', resolutionSummary: 'fp' })).status).toBe(200);
    const stored = await TransactionModel.findById(transaction._id).lean();
    expect(stored.status).toBe('APPROVED');
    expect(stored.releasedByCaseAt).toBeUndefined();
    expect(await BehaviorProfileModel.countDocuments({ userId: owner._id })).toBe(0);
  });

  it('a failing profile rebuild never fails the dismissal (best effort)', async () => {
    const x = await heldNewCityAndDevice();
    await assign(x.analyst, x.caseId);
    const spy = jest.spyOn(BehaviorProfileModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('profile boom'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patchStatus(x.analyst, x.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    spy.mockRestore();
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining('behaviour profile rebuild failed'), 'profile boom');
    quiet.mockRestore();
    expect(res.status).toBe(200);
    expect((await TransactionModel.findById(x.held.body.data.id)).status).toBe('APPROVED');
  });

  it('device counters are decremented exactly once (DISMISSED), the release is stamped once', async () => {
    const w = await workflow();
    await assign(w.analyst, w.caseId);
    await patchStatus(w.analyst, w.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    expect(await DeviceReputationModel.findOne({ deviceId: w.transaction.deviceId })).toMatchObject({ flagCount: 0, fraudTransactionCount: 0 });
    expect((await patchStatus(w.analyst, w.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' })).status).toBe(400); // closed
    expect(await DeviceReputationModel.findOne({ deviceId: w.transaction.deviceId })).toMatchObject({ flagCount: 0, fraudTransactionCount: 0 });
  });
});

describe('C-07 calcBehaviorProfile reads at most the 500 most recent trusted transactions', () => {
  it('older transactions fall out of the window', async () => {
    const { user } = await customer();
    const start = Date.now() - 600 * 60_000;
    const docs = Array.from({ length: 505 }, (_, i) => ({
      userId: user._id, amount: i < 5 ? 1_000_000 : 100 + (i % 10), merchantName: 'M', paymentMethod: 'UPI', deviceId: i < 5 ? 'ancient' : 'recent',
      location: { city: i < 5 ? 'Oldtown' : 'Newtown' }, fraudScore: 0, riskLevel: 'LOW', recommendedAction: 'APPROVE', status: 'APPROVED',
      timestamp: new Date(start + i * 60_000),
    }));
    await TransactionModel.insertMany(docs);
    const profile = await calcBehaviorProfile(user._id);
    const newest = docs.slice(5);
    expect(profile.avgTransactionAmount).toBeCloseTo(newest.reduce((s, d) => s + d.amount, 0) / 500, 6);
    expect(profile.maxTransactionAmount).toBeLessThan(200);
    expect(profile.knownDeviceIds).toEqual(['recent']);
    expect(profile.usualLocations).toEqual(['Newtown']);
  }, 60000);

  it('calcBehaviorProfile takes only the user id (the unused transaction parameter is gone)', () => {
    expect(calcBehaviorProfile.length).toBe(1);
  });
});

describe('C-07 one aggregation instead of three counts', () => {
  it('countStatuses equals the three countDocuments, for a user (id or string) and a device; empty = zeros', async () => {
    const { user } = await customer();
    const other = (await seedUser({ email: uniqueEmail('oth') })).user;
    const mk = (userId, status, deviceId) => seedTransaction({ userId, status, deviceId, riskLevel: status === 'APPROVED' ? 'LOW' : 'HIGH' });
    for (const [s, d] of [['APPROVED', 'd1'], ['APPROVED', 'd1'], ['HELD', 'd1'], ['BLOCKED', 'd2'], ['APPROVED', 'd2']]) await mk(user._id, s, d);
    await mk(other._id, 'HELD', 'd1');
    for (const userId of [user._id, String(user._id)]) {
      const viaCount = {
        total: await TransactionModel.countDocuments({ userId: user._id }),
        approved: await TransactionModel.countDocuments({ userId: user._id, status: 'APPROVED' }),
        held: await TransactionModel.countDocuments({ userId: user._id, status: 'HELD' }),
      };
      expect(await countStatuses({ userId })).toEqual(viaCount);
      expect(viaCount).toEqual({ total: 5, approved: 3, held: 1 });
    }
    expect(await countStatuses({ deviceId: 'd1' })).toEqual({ total: 4, approved: 2, held: 2 });
    expect(await countStatuses({ deviceId: 'nope' })).toEqual({ total: 0, approved: 0, held: 0 });
    expect(await updateTrustScore(user._id)).toBe(Math.round(((3 + 0.5 + 1) / (5 + 2)) * 100)); // 64
  });
});

// ── B-06 integration ────────────────────────────────────────────────────────────────────────────────
describe('B-06 stored thresholds', () => {
  it('stored nulls in SystemConfig fall back to the defaults when scoring', async () => {
    await SystemConfigModel.collection.updateOne({ singleton: 'system' }, { $set: {
      'velocityLimit.maxPerHour': null, 'velocityLimit.maxPerDay': null, amountThreshold: null, newDeviceWeight: null,
      'scoreThresholds.mediumMin': null, 'scoreThresholds.highMin': null, 'scoreThresholds.criticalMin': null,
    } });
    const { agent } = await customer();
    const res = await post(agent, txn());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ riskLevel: 'LOW', fraudScore: 0 });
    const fresh = await customer();
    const casino = await post(fresh.agent, highRisk);
    expect(casino.body.data).toMatchObject({ riskLevel: 'HIGH', fraudScore: 55 }); // 20 amount + 35 merchant with the DEFAULT 50,000 / bands
    expect(casino.body.data.reasons.join(' ')).not.toMatch(/null|NaN/);
  });

  it('the model refuses an inconsistent config through create() and save(), while the guarded PATCH and seeds still work', async () => {
    await expect(SystemConfigModel.create({ singleton: 'other', scoreThresholds: { mediumMin: 60, highMin: 50, criticalMin: 75 } })).rejects.toThrow();
    const doc = await SystemConfigModel.findOne({ singleton: 'system' });
    doc.velocityLimit.maxPerHour = 30; // maxPerDay stays 20
    await expect(doc.save()).rejects.toThrow(/maxPerDay/);
    // seeds / helpers use findOneAndUpdate; the compare-and-set PATCH too
    await seedConfig({ scoreThresholds: { mediumMin: 10, highMin: 20, criticalMin: 30 } });
    const { user, password } = await seedAdmin({ email: uniqueEmail('adm') });
    const admin = await loginAgent(user.email, password);
    const ok = await admin.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: 15 }, velocityLimit: { maxPerHour: 6 } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.scoreThresholds).toMatchObject({ mediumMin: 15, highMin: 20, criticalMin: 30 });
    expect((await admin.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: 25 } })).status).toBe(422);
  });
});

// ── A-03: analyst notifications ─────────────────────────────────────────────────────────────────────
describe('A-03 case status changes notify the other analysts', () => {
  const analystNotes = (recipientId) => NotificationModel.find({ recipientId, type: 'CASE_STATUS_CHANGED' }).sort({ createdAt: 1 }).lean();

  it('every OTHER active analyst is told about UNDER_REVIEW, RESOLVED and DISMISSED — never the actor, never an inactive analyst', async () => {
    const w = await workflow();
    const bob = await seedAnalyst({ email: uniqueEmail('bob'), name: 'Bob' });
    const carol = await seedAnalyst({ email: uniqueEmail('carol'), name: 'Carol' });
    const dave = await seedAnalyst({ email: uniqueEmail('dave'), name: 'Dave', isActive: false });
    const admin = await seedAdmin({ email: uniqueEmail('adm') });
    const publicId = (await FraudCaseModel.findById(w.caseId)).publicId;

    await assign(w.analyst, w.caseId);
    expect(await NotificationModel.countDocuments({ type: 'CASE_STATUS_CHANGED' })).toBe(0); // assigning an OPEN case: nobody lost it
    await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    for (const u of [bob.user, carol.user]) {
      const notes = await analystNotes(u._id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ recipientRole: 'ANALYST', relatedEntityType: 'FRAUD_CASE', isRead: false });
      expect(String(notes[0].relatedEntityId)).toBe(String(w.caseId));
      expect(notes[0].title).toContain(publicId);
      expect(notes[0].title).toContain('Under Review');
      expect(notes[0].message).toContain(publicId);
      expect(notes[0].message).toContain('UNDER_REVIEW');
      expect(notes[0].message).toContain('Alice Analyst');
    }
    expect(await analystNotes(w.analystUser._id)).toHaveLength(0);
    expect(await analystNotes(dave.user._id)).toHaveLength(0);
    expect(await NotificationModel.countDocuments({ recipientId: admin.user._id })).toBe(0);

    await patchStatus(w.analyst, w.caseId, { status: 'RESOLVED', resolutionSummary: 'real' });
    const afterClose = await analystNotes(bob.user._id);
    expect(afterClose).toHaveLength(2);
    expect(afterClose[1].message).toContain('RESOLVED');
    expect(afterClose[1].message).toContain('moved from UNDER_REVIEW');
    expect(afterClose[1].title).toContain('Resolved');
    expect(await analystNotes(w.analystUser._id)).toHaveLength(0);

    // the customer notification is unchanged: the original alert + one outcome
    expect(await NotificationModel.countDocuments({ recipientId: w.transaction.userId })).toBe(2);
  });

  it('DISMISSED is announced too', async () => {
    const w = await workflow();
    const bob = await seedAnalyst({ email: uniqueEmail('bob'), name: 'Bob' });
    await assign(w.analyst, w.caseId);
    await patchStatus(w.analyst, w.caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    const notes = await analystNotes(bob.user._id);
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('moved from ASSIGNED to DISMISSED');
  });

  it('a failing notification is logged and never fails the request', async () => {
    const w = await workflow();
    await seedAnalyst({ email: uniqueEmail('bob'), name: 'Bob' });
    await assign(w.analyst, w.caseId);
    const realCreate = NotificationModel.create.bind(NotificationModel);
    const spy = jest.spyOn(NotificationModel, 'create').mockImplementation((doc, ...rest) =>
      (doc?.recipientRole === 'ANALYST' ? Promise.reject(new Error('notify boom')) : realCreate(doc, ...rest)));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patchStatus(w.analyst, w.caseId, { status: 'UNDER_REVIEW' });
    spy.mockRestore();
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining('Could not notify an analyst'), 'notify boom');
    quiet.mockRestore();
    expect(res.status).toBe(200);
    expect((await FraudCaseModel.findById(w.caseId)).status).toBe('UNDER_REVIEW');
  });

  it('a failing analyst lookup is swallowed too', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(UserModel, 'find').mockImplementationOnce(() => { throw new Error('lookup boom'); });
    const n = await notifyAnalystsOfStatusChange({ fraudCase: { _id: new mongoose.Types.ObjectId(), publicId: 'CASE-2026-00001' }, previousStatus: 'ASSIGNED', newStatus: 'UNDER_REVIEW', actor: { _id: new mongoose.Types.ObjectId(), name: 'A' } });
    spy.mockRestore(); quiet.mockRestore();
    expect(n).toBe(0);
  });

  it(`is bounded: at most ${MAX_ANALYST_RECIPIENTS} recipients`, async () => {
    const actor = await seedAnalyst({ email: uniqueEmail('actor') });
    const fake = Array.from({ length: 55 }, (_, i) => ({ name: `Bulk ${i}`, email: `bulk${i}_${Math.random().toString(16).slice(2, 8)}@test.com`, password: 'x'.repeat(20), role: 'ANALYST' }));
    await UserModel.insertMany(fake);
    const n = await notifyAnalystsOfStatusChange({
      fraudCase: { _id: new mongoose.Types.ObjectId(), publicId: 'CASE-2026-00009' }, previousStatus: 'ASSIGNED', newStatus: 'DISMISSED', actor: actor.user,
    });
    expect(n).toBe(50);
    expect(MAX_ANALYST_RECIPIENTS).toBe(50);
    expect(await NotificationModel.countDocuments({ type: 'CASE_STATUS_CHANGED' })).toBe(50);
    expect(await NotificationModel.countDocuments({ recipientId: actor.user._id })).toBe(0);
  });

  it('reassigning still notifies only the previous analyst (unchanged)', async () => {
    const w = await workflow();
    const bob = await analystAgent('Bob');
    await assign(w.analyst, w.caseId);
    await assign(bob.agent, w.caseId);
    expect(await analystNotes(w.analystUser._id)).toHaveLength(1);
    expect(await analystNotes(bob.user._id)).toHaveLength(0);
  });
});

// ── A-09: audit of reads ────────────────────────────────────────────────────────────────────────────
describe('A-09 analyst reads are audited', () => {
  it('GET /analyst-api/flagged-transactions/:id writes TRANSACTION_VIEWED; a 404 writes nothing', async () => {
    const w = await workflow({ withCase: false });
    const res = await w.analyst.get(`/analyst-api/flagged-transactions/${w.transaction._id}`);
    expect(res.status).toBe(200);
    const entry = await AuditLogModel.findOne({ action: 'TRANSACTION_VIEWED' });
    expect(entry).toMatchObject({ actorRole: 'ANALYST', entityType: 'Transaction', entityId: w.transaction.publicId });
    expect(String(entry.actorId)).toBe(String(w.analystUser._id));
    expect(entry.metadata).toMatchObject({ customerId: String(w.customerUser._id), riskLevel: 'HIGH' });
    expect((await w.analyst.get(`/analyst-api/flagged-transactions/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_VIEWED' })).toBe(1);
  });

  it('GET /analyst-api/devices/:deviceId writes DEVICE_VIEWED; an unknown device writes nothing', async () => {
    const w = await workflow({ withCase: false });
    expect((await w.analyst.get(`/analyst-api/devices/${w.transaction.deviceId}`)).status).toBe(200);
    const entry = await AuditLogModel.findOne({ action: 'DEVICE_VIEWED' });
    expect(entry).toMatchObject({ actorRole: 'ANALYST', entityType: 'Device', entityId: w.transaction.deviceId });
    expect(entry.metadata).toMatchObject({ associatedUsers: 1 });
    expect((await w.analyst.get('/analyst-api/devices/unknown-device')).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: 'DEVICE_VIEWED' })).toBe(1);
  });

  it('a failing audit write never fails the read', async () => {
    const w = await workflow({ withCase: false });
    const spy = jest.spyOn(AuditLogModel, 'create').mockRejectedValue(new Error('audit boom'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const a = await w.analyst.get(`/analyst-api/flagged-transactions/${w.transaction._id}`);
    const b = await w.analyst.get(`/analyst-api/devices/${w.transaction.deviceId}`);
    spy.mockRestore(); quiet.mockRestore();
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('the admin audit-log list returns the new actions', async () => {
    const w = await workflow({ withCase: false });
    await w.analyst.get(`/analyst-api/flagged-transactions/${w.transaction._id}`);
    const { user, password } = await seedAdmin({ email: uniqueEmail('adm') });
    const admin = await loginAgent(user.email, password);
    const logs = await admin.get('/admin-api/audit-logs?entityType=Transaction');
    expect(logs.body.data.map((l) => l.action)).toContain('TRANSACTION_VIEWED');
  });

  it('the AuditLog schema now rejects an unknown action', async () => {
    const { user } = await seedUser({ email: uniqueEmail('al') });
    await expect(AuditLogModel.create({ actorId: user._id, actorRole: 'CUSTOMER', action: 'MADE_UP', entityType: 'User', entityId: 'x' })).rejects.toThrow(/Unknown audit action/);
  });

  it('a failed login for an unknown e-mail stays unaudited (the schema requires an actor; it is not weakened)', async () => {
    await supertest(app).post('/auth/login').set('X-Forwarded-For', '198.51.100.77').send({ email: 'nobody@test.com', password: 'Password@123' });
    expect(await AuditLogModel.countDocuments({ action: 'LOGIN_FAILED' })).toBe(0);
    expect(AuditLogModel.schema.path('actorId').isRequired).toBe(true);
  });
});

// ── E-20 / T-03: unique TXN ids really race ─────────────────────────────────────────────────────────
describe('TXN id uniqueness under real concurrency', () => {
  itAtomic('parallel submissions of SEVERAL users get unique TXN ids', async () => {
    await seedTransaction({ userId: (await seedUser({ email: uniqueEmail('warm') })).user._id }); // create the counter document first
    const users = await Promise.all(Array.from({ length: 5 }, (_, i) => customer(`par${i}`)));
    const results = await Promise.all(users.flatMap((u, ui) => Array.from({ length: 4 }, (_, i) =>
      post(u.agent, txn({ amount: 100 + i, deviceId: `dev-par-${ui}` })))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = results.map((r) => r.body.data.publicId);
    expect(new Set(ids).size).toBe(20);
    expect(await TransactionModel.countDocuments({ publicId: { $in: ids } })).toBe(20);
  });

  itAtomic('direct parallel createWithSequentialId calls get unique ids (the counter itself, no per-user lock in front)', async () => {
    const { user } = await customer();
    await seedTransaction({ userId: user._id, amount: 1 }); // create the counter document first
    const docs = await Promise.all(Array.from({ length: 20 }, (_, i) => seedTransaction({ userId: user._id, amount: 10 + i })));
    const ids = docs.map((d) => d.publicId);
    expect(new Set(ids).size).toBe(20);
    expect(ids.every((id) => /^TXN-\d{4}-\d{5}$/.test(id))).toBe(true);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(21);
  });
});
