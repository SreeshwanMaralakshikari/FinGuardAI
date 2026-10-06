// tests/cases.test.js — AnalystAPI investigation workflow (Phase 4, D-P6-24 partial responses)
import { beforeAll, afterAll, beforeEach, describe, it, expect, jest } from '@jest/globals';
import { itAtomic } from './helpers/dbAtomicity.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAnalyst, seedAdmin } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import NotificationModel from '../models/NotificationModel.js';
import UserModel from '../models/UserModel.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

const highRisk = { amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'CARD', deviceId: 'dev-x' };

async function setup() {
  const c = await seedUser({ email: `cust${Date.now()}@test.com` });
  const customer = await loginAgent(c.user.email, c.password);
  await customer.post('/customer-api/transactions').send(highRisk);
  const a = await seedAnalyst({ email: `an${Date.now()}@test.com` });
  const analyst = await loginAgent(a.user.email, a.password);
  const flagged = await analyst.get('/analyst-api/flagged-transactions');
  const detail = await analyst.get(`/analyst-api/flagged-transactions/${flagged.body.data[0]._id}`);
  return { analyst, analystUser: a.user, fraudAlertId: detail.body.data.fraudAlert._id, flagged, detail };
}

describe('Flagged transactions (analyst view)', () => {
  it('lists only HIGH/CRITICAL and returns full investigation context', async () => {
    const { flagged, detail } = await setup();
    expect(flagged.status).toBe(200);
    expect(flagged.body.data.every((t) => ['HIGH', 'CRITICAL'].includes(t.riskLevel))).toBe(true);
    expect(detail.body.data).toHaveProperty('transaction');
    expect(detail.body.data).toHaveProperty('deviceReputation');
    expect(detail.body.data.fraudAlert._id).toBeDefined();
    expect(detail.body.data.existingCase).toBeNull();
  });
});

describe('Case lifecycle', () => {
  it('create → assign → note → UNDER_REVIEW → RESOLVED (with summary) → closed', async () => {
    const { analyst, analystUser, fraudAlertId } = await setup();

    const created = await analyst.post('/analyst-api/cases').send({ fraudAlertId, initialNote: 'Opening investigation' });
    expect(created.status).toBe(201);
    expect(created.body.data.publicId).toMatch(/^CASE-\d{4}-\d{5}$/);
    expect(created.body.data.status).toBe('OPEN');
    const caseId = created.body.data._id;

    expect((await analyst.post('/analyst-api/cases').send({ fraudAlertId })).status).toBe(400); // one case per alert

    const assigned = await analyst.patch(`/analyst-api/cases/${caseId}/assign`).send({});
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toMatchObject({ status: 'ASSIGNED', assignedAnalystId: String(analystUser._id) });
    expect(assigned.body.data).not.toHaveProperty('_id'); // partial response (D-P6-24)

    const note = await analyst.post(`/analyst-api/cases/${caseId}/notes`).send({ text: 'Called customer' });
    expect(note.status).toBe(201);
    // N-24: the saved note sub-document, same shape as the notes in GET /cases/:id
    expect(note.body.data).toMatchObject({ text: 'Called customer', analystId: String(analystUser._id) });
    expect(note.body.data._id).toMatch(/^[0-9a-f]{24}$/);
    expect(new Date(note.body.data.createdAt).getTime()).not.toBeNaN();

    expect((await analyst.patch(`/analyst-api/cases/${caseId}/status`).send({ status: 'UNDER_REVIEW' })).status).toBe(200);
    expect((await analyst.patch(`/analyst-api/cases/${caseId}/status`).send({ status: 'RESOLVED' })).status).toBe(422); // summary required
    const resolved = await analyst.patch(`/analyst-api/cases/${caseId}/status`).send({ status: 'RESOLVED', resolutionSummary: 'Confirmed fraud' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.resolvedAt).toBeTruthy();
    expect(resolved.body.data).not.toHaveProperty('_id');

    expect((await analyst.post(`/analyst-api/cases/${caseId}/notes`).send({ text: 'late' })).status).toBe(400);

    const full = await analyst.get(`/analyst-api/cases/${caseId}`);
    expect(full.body.data.notes).toHaveLength(2);
    expect(full.body.data.fraudAlertId.status).toBe('REVIEWED');

    const unread = await analyst.get('/notification-api/notifications/unread-count');
    expect(unread.body.data.unreadCount).toBe(1); // CASE_ASSIGNED
  });

  it('AUD-25: whitespace-only resolutionSummary and non-string notes → 422', async () => {
    const { analyst, fraudAlertId } = await setup();
    const c = await analyst.post('/analyst-api/cases').send({ fraudAlertId });
    const id = c.body.data._id;
    expect((await analyst.patch(`/analyst-api/cases/${id}/status`).send({ status: 'RESOLVED', resolutionSummary: '   ' })).status).toBe(422);
    expect((await analyst.post(`/analyst-api/cases/${id}/notes`).send({ text: ['a', 'b'] })).status).toBe(422);
    expect((await analyst.post('/analyst-api/cases').send({ fraudAlertId, initialNote: ['x'] })).status).toBe(422);
  });

  it('AUD-39: fraud-pattern clusters report the number of distinct customers', async () => {
    const { analyst } = await setup(); // customer 1: one HIGH transaction on dev-x
    const c2 = await seedUser({ email: `second${Date.now()}@test.com` });
    const second = await loginAgent(c2.user.email, c2.password);
    await second.post('/customer-api/transactions').send(highRisk); // customer 2, same device dev-x
    await second.post('/customer-api/transactions').send({ ...highRisk, deviceId: 'solo' });
    await second.post('/customer-api/transactions').send({ ...highRisk, deviceId: 'solo' });
    const { sharedDeviceClusters } = (await analyst.get('/analyst-api/fraud-patterns')).body.data;
    const byDevice = Object.fromEntries(sharedDeviceClusters.map((c) => [c.deviceId, c]));
    expect(byDevice['dev-x']).toMatchObject({ count: 2, userCount: 2 }); // really shared
    expect(byDevice.solo).toMatchObject({ count: 2, userCount: 1 });     // one customer repeating
  });

  it('rejects a non-ObjectId fraudAlertId with 422', async () => {
    const { analyst } = await setup();
    expect((await analyst.post('/analyst-api/cases').send({ fraudAlertId: 'ALERT-1' })).status).toBe(422);
  });

  it('case list supports status and assignedToMe filters', async () => {
    const { analyst, fraudAlertId } = await setup();
    const c = await analyst.post('/analyst-api/cases').send({ fraudAlertId });
    expect((await analyst.get('/analyst-api/cases?status=OPEN')).body.data).toHaveLength(1);
    expect((await analyst.get('/analyst-api/cases?assignedToMe=true')).body.data).toHaveLength(0);
    await analyst.patch(`/analyst-api/cases/${c.body.data._id}/assign`).send({});
    expect((await analyst.get('/analyst-api/cases?assignedToMe=true')).body.data).toHaveLength(1);
  });

  it('device lookup and fraud patterns respond', async () => {
    const { analyst } = await setup();
    expect((await analyst.get('/analyst-api/devices/dev-x')).body.data.device.deviceId).toBe('dev-x');
    expect((await analyst.get('/analyst-api/devices/unknown')).status).toBe(404);
    const patterns = await analyst.get('/analyst-api/fraud-patterns');
    expect(patterns.status).toBe(200);
    expect(patterns.body.data).toHaveProperty('sharedDeviceClusters');
  });
});

// ── Fix round: L-02 / L-04 / N-24 / N-25 — case workflow integrity ───────────────

let seq = 0;
const uniq = () => `${Date.now()}_${(seq += 1)}`;

/** A customer with a HELD transaction + alert, one analyst, and (optionally) an open case. */
async function workflow({ withCase = true } = {}) {
  const c = await seedUser({ email: `wfc${uniq()}@test.com` });
  const customer = await loginAgent(c.user.email, c.password);
  const submitted = await customer.post('/customer-api/transactions').send(highRisk);
  const a = await seedAnalyst({ email: `wfa${uniq()}@test.com`, name: 'Alice Analyst' });
  const analyst = await loginAgent(a.user.email, a.password);
  const transaction = await TransactionModel.findById(submitted.body.data.id);
  const alertId = submitted.body.data.fraudAlert.id;
  const out = { customer, customerUser: c.user, analyst, analystUser: a.user, transaction, alertId, submitted };
  if (withCase) {
    const created = await analyst.post('/analyst-api/cases').send({ fraudAlertId: alertId });
    out.caseId = created.body.data._id;
  }
  return out;
}

async function secondAnalyst() {
  const b = await seedAnalyst({ email: `wfb${uniq()}@test.com`, name: 'Bob Analyst' });
  return { analyst: await loginAgent(b.user.email, b.password), analystUser: b.user };
}

const patchStatus = (agent, caseId, body) => agent.patch(`/analyst-api/cases/${caseId}/status`).send(body);
const assign = (agent, caseId) => agent.patch(`/analyst-api/cases/${caseId}/assign`).send({});

describe('L-04 status transitions are enforced', () => {
  it('an OPEN (unassigned) case cannot change status at all — it must be assigned first', async () => {
    const { analyst, caseId } = await workflow();
    for (const status of ['ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'OPEN']) {
      const res = await patchStatus(analyst, caseId, { status, resolutionSummary: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not assigned yet/);
    }
    expect((await FraudCaseModel.findById(caseId)).status).toBe('OPEN');
  });

  it('only the documented moves are accepted; everything else is a 400 with a message', async () => {
    const { analyst, caseId } = await workflow();
    await assign(analyst, caseId);
    for (const status of ['OPEN', 'ASSIGNED', 'RESOLVED']) { // from ASSIGNED
      const res = await patchStatus(analyst, caseId, { status, resolutionSummary: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot move to/);
    }
    expect((await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' })).status).toBe(200);
    for (const status of ['OPEN', 'ASSIGNED', 'UNDER_REVIEW']) { // from UNDER_REVIEW
      expect((await patchStatus(analyst, caseId, { status })).status).toBe(400);
    }
    expect((await FraudCaseModel.findById(caseId)).status).toBe('UNDER_REVIEW');
    expect((await patchStatus(analyst, caseId, { status: 'RESOLVED', resolutionSummary: 'done' })).status).toBe(200);
  });

  it('ASSIGNED → DISMISSED directly is allowed', async () => {
    const { analyst, caseId } = await workflow();
    await assign(analyst, caseId);
    expect((await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'false positive' })).status).toBe(200);
  });

  it('closed cases reject every change with 400 — status, assign and notes', async () => {
    const { analyst, caseId } = await workflow();
    await assign(analyst, caseId);
    await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    expect((await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' })).status).toBe(400);
    expect((await assign(analyst, caseId)).status).toBe(400);
    expect((await analyst.post(`/analyst-api/cases/${caseId}/notes`).send({ text: 'late' })).status).toBe(400);
    const { analyst: bob } = await secondAnalyst();
    expect((await patchStatus(bob, caseId, { status: 'UNDER_REVIEW' })).status).toBe(400); // closed wins over "not your case"
  });

  it('unknown case ids → 404, malformed → 400', async () => {
    const { analyst } = await workflow({ withCase: false });
    const missing = '64b64b64b64b64b64b64b64b';
    expect((await patchStatus(analyst, missing, { status: 'UNDER_REVIEW' })).status).toBe(404);
    expect((await assign(analyst, missing)).status).toBe(404);
    expect((await analyst.post(`/analyst-api/cases/${missing}/notes`).send({ text: 'x' })).status).toBe(404);
    expect((await patchStatus(analyst, 'nope', { status: 'UNDER_REVIEW' })).status).toBe(400);
  });
});

describe('L-04 only the assigned analyst changes the status; reassigning keeps the status', () => {
  it('another analyst gets 403; the owner can continue', async () => {
    const { analyst, caseId } = await workflow();
    const { analyst: bob } = await secondAnalyst();
    await assign(analyst, caseId);
    const res = await patchStatus(bob, caseId, { status: 'UNDER_REVIEW' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, message: 'Only the assigned analyst can change the status.' });
    expect((await FraudCaseModel.findById(caseId)).status).toBe('ASSIGNED');
    expect((await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' })).status).toBe(200);
  });

  it('taking over an UNDER_REVIEW case keeps UNDER_REVIEW, moves the ownership and tells the previous analyst', async () => {
    const { analyst: alice, analystUser: aliceUser, caseId } = await workflow();
    const { analyst: bob, analystUser: bobUser } = await secondAnalyst();
    await assign(alice, caseId);
    await patchStatus(alice, caseId, { status: 'UNDER_REVIEW' });

    const taken = await assign(bob, caseId);
    expect(taken.status).toBe(200);
    expect(taken.body.data).toEqual({ publicId: expect.stringMatching(/^CASE-/), status: 'UNDER_REVIEW', assignedAnalystId: String(bobUser._id) });
    const stored = await FraudCaseModel.findById(caseId);
    expect(stored.status).toBe('UNDER_REVIEW');
    expect(String(stored.assignedAnalystId)).toBe(String(bobUser._id));

    expect((await patchStatus(alice, caseId, { status: 'RESOLVED', resolutionSummary: 'x' })).status).toBe(403); // Alice lost it
    const told = await NotificationModel.findOne({ recipientId: aliceUser._id, type: 'CASE_STATUS_CHANGED' });
    expect(told.title).toMatch(/Reassigned/);
    expect(told.message).toMatch(/reassigned to Bob Analyst/);
    expect((await patchStatus(bob, caseId, { status: 'RESOLVED', resolutionSummary: 'done by Bob' })).status).toBe(200);

    const audit = await AuditLogModel.findOne({ action: 'CASE_ASSIGNED', actorId: bobUser._id });
    expect(audit.metadata).toMatchObject({ previousAnalyst: String(aliceUser._id), newAnalyst: String(bobUser._id), previousStatus: 'UNDER_REVIEW', status: 'UNDER_REVIEW' });
  });

  it('assigning a case that is already yours changes and notifies nothing', async () => {
    const { analyst, analystUser, caseId } = await workflow();
    await assign(analyst, caseId);
    const again = await assign(analyst, caseId);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('ASSIGNED');
    expect(await NotificationModel.countDocuments({ recipientId: analystUser._id })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'CASE_ASSIGNED' })).toBe(1);
  });

  it('lost race (stale read): assigning a case someone else took meanwhile is a 409 and overwrites nothing', async () => {
    const { analyst: alice, caseId } = await workflow();
    const { analyst: bob, analystUser: bobUser } = await secondAnalyst();
    const stale = await FraudCaseModel.findById(caseId); // alice's view: OPEN, unassigned
    await assign(bob, caseId);                           // bob takes it first
    const spy = jest.spyOn(FraudCaseModel, 'findById').mockImplementationOnce(() => Promise.resolve(stale));
    const res = await assign(alice, caseId);
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/updated by someone else/);
    expect(String((await FraudCaseModel.findById(caseId)).assignedAnalystId)).toBe(String(bobUser._id));
  });

  itAtomic('two analysts grabbing an OPEN case at once: exactly one wins, the other is told it changed', async () => {
    const { analyst: alice, caseId } = await workflow();
    const { analyst: bob } = await secondAnalyst();
    const [r1, r2] = await Promise.all([assign(alice, caseId), assign(bob, caseId)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.message).toMatch(/updated by someone else/);
  });
});

describe('L-02 closing a case releases the transaction and informs the customer', () => {
  it('DISMISSED (false positive): alert DISMISSED, HELD → APPROVED, customer notified, lossPrevented drops', async () => {
    const { customer, customerUser, analyst, caseId, transaction, alertId } = await workflow();
    const adm = await seedAdmin({ email: `adm${uniq()}@test.com` });
    const admin = await loginAgent(adm.user.email, adm.password);
    expect(transaction.status).toBe('HELD');
    const before = (await admin.get('/admin-api/analytics')).body.data.lossPrevented;
    expect(before).toBeGreaterThan(0);
    const trustBefore = (await UserModel.findById(customerUser._id)).trustScore;

    await assign(analyst, caseId);
    const res = await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'Customer confirmed the payment' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'DISMISSED' });
    expect(res.body.data.resolvedAt).toBeTruthy();

    expect((await TransactionModel.findById(transaction._id)).status).toBe('APPROVED');
    expect((await FraudAlertModel.findById(alertId)).status).toBe('DISMISSED');
    expect((await admin.get('/admin-api/analytics')).body.data.lossPrevented).toBe(0);
    expect((await UserModel.findById(customerUser._id)).trustScore).toBeGreaterThan(trustBefore); // false positive no longer counts against them

    // the customer sees the outcome everywhere
    const alerts = await customer.get('/customer-api/fraud-alerts');
    expect(alerts.body.data[0]).toMatchObject({ status: 'DISMISSED' });
    expect(alerts.body.data[0].transactionId.status).toBe('APPROVED');
    const notes = (await customer.get('/notification-api/notifications')).body.data;
    expect(notes).toHaveLength(2); // the original alert + the outcome
    const outcome = notes[0];
    expect(outcome).toMatchObject({ type: 'FRAUD_ALERT', title: 'Flagged Transaction Cleared', isRead: false, relatedEntityType: 'FRAUD_ALERT' });
    expect(outcome.message).toContain(transaction.publicId);
    expect(outcome.message).toMatch(/released and is now approved/);
    expect(outcome.message).not.toMatch(/Customer confirmed/); // analyst's internal summary is not shared

    const actions = (await AuditLogModel.find({})).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['CASE_STATUS_CHANGED', 'FRAUD_ALERT_STATUS_CHANGED', 'TRANSACTION_RELEASED']));
  });

  it('RESOLVED: alert REVIEWED, the transaction stays HELD, customer notified', async () => {
    const { customer, analyst, caseId, transaction, alertId } = await workflow();
    await assign(analyst, caseId);
    await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' });
    expect((await patchStatus(analyst, caseId, { status: 'RESOLVED', resolutionSummary: 'Confirmed fraud' })).status).toBe(200);
    expect((await TransactionModel.findById(transaction._id)).status).toBe('HELD');
    expect((await FraudAlertModel.findById(alertId)).status).toBe('REVIEWED');
    const outcome = (await customer.get('/notification-api/notifications')).body.data[0];
    expect(outcome).toMatchObject({ type: 'FRAUD_ALERT', title: 'Fraud Review Completed' });
    expect(outcome.message).toMatch(/remains held/);
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_RELEASED' })).toBe(0);
  });

  it('DISMISSED releases a BLOCKED transaction too, and leaves an already APPROVED (MEDIUM) one alone', async () => {
    const { analyst } = await workflow({ withCase: false });
    const customerUser = (await seedUser({ email: `owner${uniq()}@test.com` })).user;
    const mk = async (status, riskLevel) => {
      const transaction = await seedTransaction({ userId: customerUser._id, status, riskLevel, fraudScore: 80, recommendedAction: 'BLOCK', deviceId: `dev-${uniq()}`, estimatedLoss: 500 });
      const alert = await FraudAlertModel.create({ transactionId: transaction._id, userId: customerUser._id, alertType: 'COMPOSITE', riskLevel, fraudScore: 80, reasons: [] });
      const created = await analyst.post('/analyst-api/cases').send({ fraudAlertId: String(alert._id) });
      const caseId = created.body.data._id;
      await assign(analyst, caseId);
      await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
      return { transaction, alert };
    };
    const blocked = await mk('BLOCKED', 'CRITICAL');
    expect((await TransactionModel.findById(blocked.transaction._id)).status).toBe('APPROVED');
    const medium = await mk('APPROVED', 'MEDIUM');
    expect((await TransactionModel.findById(medium.transaction._id)).status).toBe('APPROVED');
    expect((await FraudAlertModel.findById(medium.alert._id)).status).toBe('DISMISSED');
    const msgs = (await NotificationModel.find({ recipientId: customerUser._id }).sort({ createdAt: 1 })).map((n) => n.message);
    expect(msgs[0]).toMatch(/released and is now approved/);
    expect(msgs[1]).toMatch(/The alert has been closed\./);
  });

  it('device reputation is recalculated without counting the transaction twice', async () => {
    const { analyst, caseId, transaction } = await workflow();
    const DeviceReputationModel = (await import('../models/DeviceReputationModel.js')).default;
    const before = await DeviceReputationModel.findOne({ deviceId: transaction.deviceId });
    expect(before.reputationScore).toBe(88); // one HELD: (0.5 + 3) / (1 + 3)
    await assign(analyst, caseId);
    await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'fp' });
    const after = await DeviceReputationModel.findOne({ deviceId: transaction.deviceId });
    expect(after.reputationScore).toBe(100); // (1 + 3) / (1 + 3)
    // B-3: the released false positive is taken back out of the counters (once, never below 0)
    expect(before.flagCount).toBe(1);
    expect(after.flagCount).toBe(before.flagCount - 1);
    expect(after.fraudTransactionCount).toBe(before.fraudTransactionCount - 1);
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
  });
});

describe('round 2: a failed close can be retried', () => {
  it('if the side effects fail the case is reopened, so the analyst can retry and it then completes', async () => {
    const { analyst, caseId, transaction, alertId } = await workflow();
    await assign(analyst, caseId);
    const spy = jest.spyOn(FraudAlertModel, 'updateOne').mockRejectedValueOnce(new Error('db hiccup'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'false positive' });
    spy.mockRestore();
    quiet.mockRestore();
    expect(failed.status).toBe(500);
    const reopened = await FraudCaseModel.findById(caseId);
    expect(reopened.status).toBe('ASSIGNED');
    expect(reopened.resolvedAt ?? null).toBeNull();
    expect((await TransactionModel.findById(transaction._id)).status).toBe('HELD');

    const retry = await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'false positive' });
    expect(retry.status).toBe(200);
    expect((await TransactionModel.findById(transaction._id)).status).toBe('APPROVED');
    expect((await FraudAlertModel.findById(alertId)).status).toBe('DISMISSED');
  });
});

describe('L-04 races', () => {
  it('lost race (stale read): closing a case that moved on meanwhile is a 409 / 400 and has NO side effects', async () => {
    const { analyst, caseId, transaction, alertId } = await workflow();
    await assign(analyst, caseId);
    const stale = await FraudCaseModel.findById(caseId); // the analyst's view: ASSIGNED
    await FraudCaseModel.updateOne({ _id: caseId }, { $set: { status: 'UNDER_REVIEW' } }); // …but it moved on
    let spy = jest.spyOn(FraudCaseModel, 'findById').mockImplementationOnce(() => Promise.resolve(stale));
    const changed = await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'false positive' });
    spy.mockRestore();
    expect(changed.status).toBe(409);
    expect(changed.body.message).toMatch(/updated by someone else/);
    expect((await FraudCaseModel.findById(caseId)).status).toBe('UNDER_REVIEW');
    expect((await TransactionModel.findById(transaction._id)).status).toBe('HELD');   // nothing released
    expect((await FraudAlertModel.findById(alertId)).status).toBe('REVIEWED');        // alert untouched
    expect(await NotificationModel.countDocuments({ recipientId: transaction.userId })).toBe(1); // only the original alert notice

    // …and when the case was CLOSED in the meantime the answer is the plain "already closed" 400
    await FraudCaseModel.updateOne({ _id: caseId }, { $set: { status: 'RESOLVED' } });
    spy = jest.spyOn(FraudCaseModel, 'findById').mockImplementationOnce(() => Promise.resolve(stale));
    const closed = await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' });
    spy.mockRestore();
    expect(closed.status).toBe(400);
    expect(closed.body.message).toBe('This case is already closed and cannot be updated.');
  });

  itAtomic('two simultaneous closes of one case: exactly one wins and the side effects match the winner', async () => {
    const { analyst, caseId, transaction, alertId } = await workflow();
    await assign(analyst, caseId);
    await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW' });
    const [a, b] = await Promise.all([
      patchStatus(analyst, caseId, { status: 'RESOLVED', resolutionSummary: 'real fraud' }),
      patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: 'false positive' }),
    ]);
    expect([a.status, b.status].filter((x) => x === 200)).toHaveLength(1);
    expect([a.status, b.status].find((x) => x !== 200)).toBeGreaterThanOrEqual(400);
    const winner = a.status === 200 ? 'RESOLVED' : 'DISMISSED';
    expect((await FraudCaseModel.findById(caseId)).status).toBe(winner);
    expect((await FraudAlertModel.findById(alertId)).status).toBe(winner === 'RESOLVED' ? 'REVIEWED' : 'DISMISSED');
    expect((await TransactionModel.findById(transaction._id)).status).toBe(winner === 'RESOLVED' ? 'HELD' : 'APPROVED');
    expect(await NotificationModel.countDocuments({ recipientId: transaction.userId, title: /Cleared|Completed/ })).toBe(1);
  });

  it('the unique index catches a duplicate that slips past the pre-check → the same 400, no second case', async () => {
    const { analyst, alertId } = await workflow(); // a case already exists for the alert
    const spy = jest.spyOn(FraudCaseModel, 'exists').mockImplementationOnce(() => Promise.resolve(null)); // pre-check "misses" (the race)
    const res = await analyst.post('/analyst-api/cases').send({ fraudAlertId: alertId });
    spy.mockRestore();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'A case already exists for this alert.' });
    expect(await FraudCaseModel.countDocuments({ fraudAlertId: alertId })).toBe(1);
  });

  itAtomic('two simultaneous "create case" requests for one alert: one 201, one 400, one case in the database', async () => {
    const { analyst, alertId } = await workflow({ withCase: false });
    const [a, b] = await Promise.all([
      analyst.post('/analyst-api/cases').send({ fraudAlertId: alertId }),
      analyst.post('/analyst-api/cases').send({ fraudAlertId: alertId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const loser = a.status === 400 ? a : b;
    expect(loser.body).toEqual({ success: false, message: 'A case already exists for this alert.' });
    expect(await FraudCaseModel.countDocuments({ fraudAlertId: alertId })).toBe(1);
  });

  it('a later duplicate gets the same 400 message, and the database has a UNIQUE index on fraudAlertId', async () => {
    const { analyst, alertId } = await workflow();
    const dup = await analyst.post('/analyst-api/cases').send({ fraudAlertId: alertId });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toBe('A case already exists for this alert.');
    const indexes = await FraudCaseModel.collection.indexes();
    expect(indexes.find((i) => i.key.fraudAlertId === 1)?.unique).toBe(true);
    expect(indexes.some((i) => i.key.transactionId === 1)).toBe(true);
    await expect(FraudCaseModel.create({ fraudAlertId: alertId, transactionId: new (await import('mongoose')).default.Types.ObjectId() }))
      .rejects.toMatchObject({ code: 11000 });
  });

  it('notes accumulate in order, each with its own _id, and the closed-case guard applies', async () => {
    const { analyst, caseId } = await workflow();
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await analyst.post(`/analyst-api/cases/${caseId}/notes`).send({ text: `  note ${i}  ` });
      expect(res.status).toBe(201);
      expect(res.body.data.text).toBe(`note ${i}`); // trimmed
      ids.push(res.body.data._id);
    }
    const stored = await FraudCaseModel.findById(caseId);
    expect(stored.notes.map((n) => String(n._id))).toEqual(ids);
    expect(stored.notes.map((n) => n.text)).toEqual(['note 0', 'note 1', 'note 2', 'note 3']);
    const detail = await analyst.get(`/analyst-api/cases/${caseId}`);
    expect(detail.body.data.notes[0].analystId).toMatchObject({ name: 'Alice Analyst' }); // GET populates the analyst; POST returns the bare id
  });

  itAtomic('parallel notes are all kept (atomic append), each with its own _id', async () => {
    const { analyst, caseId } = await workflow();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => analyst.post(`/analyst-api/cases/${caseId}/notes`).send({ text: `note ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data._id)).size).toBe(6);
    const stored = await FraudCaseModel.findById(caseId);
    expect(stored.notes).toHaveLength(6);
    expect(stored.notes.map((n) => String(n._id)).sort()).toEqual(results.map((r) => r.body.data._id).sort());
  });
});

describe('N-25 resolutionSummary validation', () => {
  it('must be a string whenever present — also for non-closing statuses (no raw Mongoose cast error)', async () => {
    const { analyst, caseId } = await workflow();
    await assign(analyst, caseId);
    for (const resolutionSummary of [{ a: 1 }, ['x'], 123, true]) {
      const res = await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW', resolutionSummary });
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/Resolution summary must be a string/);
    }
    expect((await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW', resolutionSummary: 'x'.repeat(5001) })).status).toBe(422);
    expect((await FraudCaseModel.findById(caseId)).status).toBe('ASSIGNED');
    const ok = await patchStatus(analyst, caseId, { status: 'UNDER_REVIEW', resolutionSummary: 'Interim finding' });
    expect(ok.status).toBe(200);
    expect((await FraudCaseModel.findById(caseId)).resolutionSummary).toBe('Interim finding');
  });

  it('still required (non-empty string) for RESOLVED and DISMISSED; status itself must be a string', async () => {
    const { analyst, caseId } = await workflow();
    await assign(analyst, caseId);
    expect((await patchStatus(analyst, caseId, { status: 'DISMISSED' })).status).toBe(422);
    expect((await patchStatus(analyst, caseId, { status: 'DISMISSED', resolutionSummary: { a: 1 } })).status).toBe(422);
    expect((await patchStatus(analyst, caseId, { status: ['DISMISSED'], resolutionSummary: 'x' })).status).toBe(422);
    expect((await patchStatus(analyst, caseId, { status: 'NOPE' })).status).toBe(422);
  });
});

describe('Date filters (L-05) on the analyst API', () => {
  it('a single IST day returns that day\'s flagged transactions; invalid dates → 400', async () => {
    const { analyst, transaction } = await workflow({ withCase: false });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(transaction.timestamp);
    const hit = await analyst.get(`/analyst-api/flagged-transactions?startDate=${day}&endDate=${day}`);
    expect(hit.status).toBe(200);
    expect(hit.body.data).toHaveLength(1);
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(transaction.timestamp.getTime() - 86400000));
    expect((await analyst.get(`/analyst-api/flagged-transactions?startDate=${yesterday}&endDate=${yesterday}`)).body.data).toHaveLength(0);
    expect((await analyst.get('/analyst-api/flagged-transactions?startDate=not-a-date')).status).toBe(400);
    expect((await analyst.get('/analyst-api/flagged-transactions?endDate=2026-02-31')).status).toBe(400);
  });
});
