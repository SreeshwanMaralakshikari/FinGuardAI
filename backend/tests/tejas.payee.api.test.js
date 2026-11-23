// tests/tejas.payee.api.test.js — TEJAS D1 (step 1): payees, payee signals (shadow mode), watchlist, payee profile.
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAnalyst, uniqueEmail } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';
import TransactionModel from '../models/TransactionModel.js';
import PayeeWatchlistModel from '../models/PayeeWatchlistModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { backfillPayees } from '../seed/backfillPayees.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

const MULE = 'mule.collect01@ybl';
const txn = (o = {}) => ({
  amount: 500, merchantName: 'BookStore', merchantCategory: 'RETAIL', paymentMethod: 'UPI',
  location: { city: 'Mumbai', country: 'IN' }, deviceId: 'dev-safe', ...o,
});
// A fresh device per call: a device id shared between tests' customers would carry its reputation from one payment
// into the next and change the score.
let deviceCounter = 0;
const highRisk = (o = {}) => {
  deviceCounter += 1;
  return txn({
    amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'CARD',
    deviceId: `dev-x-${deviceCounter}`, ...o,
  });
};
const pay = (agent, body) => agent.post('/customer-api/transactions').send(body);

async function customer(prefix = 'c', name = 'Test User') {
  const { user, password } = await seedUser({ email: uniqueEmail(prefix), name });
  return { user, agent: await loginAgent(user.email, password) };
}
async function analyst(name = 'Alice Analyst') {
  const { user, password } = await seedAnalyst({ email: uniqueEmail('an'), name });
  return { user, agent: await loginAgent(user.email, password) };
}
const patchStatus = (agent, caseId, body) => agent.patch(`/analyst-api/cases/${caseId}/status`).send(body);
const assign = (agent, caseId) => agent.patch(`/analyst-api/cases/${caseId}/assign`).send({});

/** Submit a held payment as a new customer, open a case, and close it with `outcome`. */
async function closedCase(outcome, payment) {
  const c = await customer('wf');
  const submitted = await pay(c.agent, payment);
  expect(submitted.status).toBe(201);
  expect(['HELD', 'BLOCKED']).toContain(submitted.body.data.status);
  expect(submitted.body.data.fraudAlert).not.toBeNull();
  const a = await analyst();
  const caseId = (await a.agent.post('/analyst-api/cases').send({ fraudAlertId: submitted.body.data.fraudAlert.id })).body.data._id;
  expect((await assign(a.agent, caseId)).status).toBe(200);
  expect((await patchStatus(a.agent, caseId, { status: 'UNDER_REVIEW' })).status).toBe(200);
  const res = await patchStatus(a.agent, caseId, { status: outcome, resolutionSummary: 'checked' });
  expect(res.status).toBe(200);
  return { customer: c, analyst: a, caseId, transactionId: submitted.body.data.id };
}

describe('payee on submit (shadow mode)', () => {
  it('stores the UPI ID payee and signals; the customer sees only their own view', async () => {
    const c = await customer();
    const res = await pay(c.agent, txn({ payeeVpa: '  Mule.Collect01@YBL ' }));
    expect(res.status).toBe(201);
    expect(res.body.data.payee).toEqual({ key: `vpa:${MULE}`, vpa: MULE });
    expect(res.body.data.payeeSignals).toEqual({ firstTimePayee: true, watchlisted: false });

    const stored = await TransactionModel.findById(res.body.data.id).lean();
    expect(stored.payee).toEqual({ key: `vpa:${MULE}`, vpa: MULE });
    expect(stored.payeeSignals).toEqual({
      firstTimePayee: true, payeeAgeDays: 0, sendersLast24h: 0, inflowLast24h: 0, watchlisted: false,
    });
  });

  it('counts earlier payments only: second payment, other customers, inflow', async () => {
    const a = await customer('a');
    const b = await customer('b');
    await pay(a.agent, txn({ payeeVpa: MULE, amount: 500 }));
    const second = await pay(a.agent, txn({ payeeVpa: MULE, amount: 250.25 }));
    expect(second.body.data.payeeSignals).toEqual({ firstTimePayee: false, watchlisted: false });
    expect((await TransactionModel.findById(second.body.data.id).lean()).payeeSignals)
      .toMatchObject({ firstTimePayee: false, sendersLast24h: 1, inflowLast24h: 500 });

    const fromB = await pay(b.agent, txn({ payeeVpa: MULE, amount: 100 }));
    expect(fromB.body.data.payeeSignals.firstTimePayee).toBe(true);           // B never paid it
    expect((await TransactionModel.findById(fromB.body.data.id).lean()).payeeSignals)
      .toMatchObject({ sendersLast24h: 1, inflowLast24h: 750.25 });          // A, twice; B not yet counted
  });

  it('payments older than 24 h count for age and "paid before", not for the 24 h window', async () => {
    const a = await customer('old');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 60_000);
    await seedTransaction({ userId: a.user._id, amount: 900, timestamp: threeDaysAgo, payee: { key: `vpa:${MULE}`, vpa: MULE } });
    const res = await pay(a.agent, txn({ payeeVpa: MULE }));
    expect((await TransactionModel.findById(res.body.data.id).lean()).payeeSignals).toEqual({
      firstTimePayee: false, payeeAgeDays: 3, sendersLast24h: 0, inflowLast24h: 0, watchlisted: false,
    });
  });

  it('without a UPI ID the merchant is the payee, matched case- and space-insensitively', async () => {
    const c = await customer();
    const first = await pay(c.agent, txn({ merchantName: 'Book  Store' }));
    expect(first.body.data.payee).toEqual({ key: 'merchant:book store' });
    const again = await pay(c.agent, txn({ merchantName: 'BOOK STORE' }));
    expect(again.body.data.payeeSignals.firstTimePayee).toBe(false);
  });

  it('does not change the fraud score yet (step 1 is shadow mode)', async () => {
    const a = await customer('s1');
    const b = await customer('s2');
    const plain = await pay(a.agent, highRisk());
    const withVpa = await pay(b.agent, highRisk({ payeeVpa: MULE }));
    expect(withVpa.body.data.fraudScore).toBe(plain.body.data.fraudScore);
    expect(withVpa.body.data.riskLevel).toBe(plain.body.data.riskLevel);
  });

  it('rejects a malformed UPI ID with 422 and stores nothing', async () => {
    const c = await customer();
    for (const payeeVpa of ['ravi', 'ravi@ybl1', ['a@ybl'], { $ne: '' }]) {
      const res = await pay(c.agent, txn({ payeeVpa }));
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/name@bank/);
    }
    expect(await TransactionModel.countDocuments({})).toBe(0);
  });

  it('an idempotent replay returns the same payee', async () => {
    const c = await customer();
    const send = () => c.agent.post('/customer-api/transactions').set('Idempotency-Key', 'payee-replay-001').send(txn({ payeeVpa: MULE }));
    const first = await send();
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.data.payee).toEqual(first.body.data.payee);
    expect(again.body.data.payeeSignals).toEqual(first.body.data.payeeSignals);
    expect(await TransactionModel.countDocuments({})).toBe(1);
  });
});

describe('analyst watchlist', () => {
  it('add → list → remove → re-add, every change audited', async () => {
    const { agent, user } = await analyst();
    const added = await agent.post('/analyst-api/payees/watchlist').send({ vpa: ' Mule.Collect01@YBL ', note: 'reported by 3 victims' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ key: `vpa:${MULE}`, vpa: MULE, label: MULE, source: 'ANALYST_REPORT', active: true, note: 'reported by 3 victims' });

    const twice = await agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE });
    expect(twice.status).toBe(200);
    expect(twice.body.message).toMatch(/already/);
    expect(await PayeeWatchlistModel.countDocuments({})).toBe(1);

    const list = await agent.get('/analyst-api/payees/watchlist');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].addedBy).toMatchObject({ name: 'Alice Analyst' });
    expect(list.body.pagination).toMatchObject({ page: 1, total: 1 });

    const id = added.body.data.id;
    const removed = await agent.delete(`/analyst-api/payees/watchlist/${id}`).send({ note: 'false report' });
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ active: false, removalNote: 'false report' });
    expect((await agent.delete(`/analyst-api/payees/watchlist/${id}`).send({})).status).toBe(404);
    expect((await agent.get('/analyst-api/payees/watchlist')).body.data).toHaveLength(0);
    expect((await agent.get('/analyst-api/payees/watchlist?status=removed')).body.data).toHaveLength(1);
    expect((await agent.get('/analyst-api/payees/watchlist?status=all')).body.data).toHaveLength(1);

    const back = await agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE });
    expect(back.status).toBe(200);
    expect(back.body.message).toMatch(/added/);
    expect(back.body.data).toMatchObject({ id, active: true });
    expect(back.body.data.removedAt).toBeUndefined();

    const audits = await AuditLogModel.find({ entityType: 'PayeeWatchlist' }).sort({ timestamp: 1, _id: 1 }).lean();
    expect(audits.map((a) => a.action)).toEqual(['PAYEE_WATCHLISTED', 'PAYEE_UNWATCHLISTED', 'PAYEE_WATCHLISTED']);
    expect(audits.every((a) => String(a.actorId) === String(user._id))).toBe(true);
  });

  it('a merchant can be added by name', async () => {
    const { agent } = await analyst();
    const res = await agent.post('/analyst-api/payees/watchlist').send({ merchantName: '  Lucky   Prize Desk ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ key: 'merchant:lucky prize desk', label: 'Lucky   Prize Desk' });
    expect(res.body.data.vpa).toBeUndefined();
  });

  it('validation and access control', async () => {
    const { agent } = await analyst();
    expect((await agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE, merchantName: 'X' })).status).toBe(422);
    expect((await agent.post('/analyst-api/payees/watchlist').send({})).status).toBe(422);
    expect((await agent.delete('/analyst-api/payees/watchlist/not-an-id').send({})).status).toBe(422);
    expect((await agent.get('/analyst-api/payees/watchlist?status=gone')).status).toBe(422);

    const c = await customer();
    expect((await c.agent.get('/analyst-api/payees/watchlist')).status).toBe(403);
    expect((await c.agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE })).status).toBe(403);
    expect(await PayeeWatchlistModel.countDocuments({})).toBe(0);
  });

  it('a watchlisted payee is flagged on the next payment (score unchanged in step 1)', async () => {
    const { agent } = await analyst();
    const c = await customer();
    const before = await pay(c.agent, txn({ payeeVpa: MULE, merchantName: 'Friend' }));
    await agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE });
    const after = await pay(c.agent, txn({ payeeVpa: MULE, merchantName: 'Friend' }));
    expect(after.body.data.payeeSignals).toEqual({ firstTimePayee: false, watchlisted: true });
    expect(after.body.data.fraudScore).toBe(before.body.data.fraudScore);
  });
});

describe('confirmed fraud feeds the watchlist', () => {
  it('RESOLVED with a UPI ID payee → CONFIRMED_FRAUD entry with the case as evidence, audited', async () => {
    const { caseId, analyst: a } = await closedCase('RESOLVED', highRisk({ payeeVpa: MULE }));
    const entry = await PayeeWatchlistModel.findOne({ key: `vpa:${MULE}` }).lean();
    expect(entry).toMatchObject({ source: 'CONFIRMED_FRAUD', active: true, vpa: MULE });
    expect(entry.caseIds.map(String)).toEqual([String(caseId)]);
    expect(String(entry.addedBy)).toBe(String(a.user._id));
    expect(await AuditLogModel.countDocuments({ action: 'PAYEE_WATCHLISTED', 'metadata.source': 'CONFIRMED_FRAUD' })).toBe(1);
  });

  it('a second confirmed case adds evidence to the same entry', async () => {
    await closedCase('RESOLVED', highRisk({ payeeVpa: MULE }));
    await closedCase('RESOLVED', highRisk({ payeeVpa: MULE }));
    const entries = await PayeeWatchlistModel.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].caseIds).toHaveLength(2);
    expect(await AuditLogModel.countDocuments({ action: 'PAYEE_WATCHLISTED' })).toBe(1); // evidence only, no new listing
  });

  it('merchant payees and DISMISSED cases never add an entry', async () => {
    await closedCase('RESOLVED', highRisk());                    // no UPI ID: the casino merchant is not listed
    await closedCase('DISMISSED', highRisk({ payeeVpa: MULE })); // false alarm
    expect(await PayeeWatchlistModel.countDocuments({})).toBe(0);
  });
});

describe('payee profile', () => {
  it('totals, 24 h window, risk mix, recent payments; audited', async () => {
    const a = await customer('pa', 'Asha');
    const b = await customer('pb', 'Bala');
    await pay(a.agent, txn({ payeeVpa: MULE, amount: 300 }));
    await pay(b.agent, txn({ payeeVpa: MULE, amount: 200 }));
    await pay(b.agent, highRisk({ payeeVpa: MULE }));
    const { agent } = await analyst();

    const res = await agent.get('/analyst-api/payees/profile').query({ key: `vpa:${MULE}` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      key: `vpa:${MULE}`,
      label: MULE,
      totals: { payments: 3, amount: 60500, distinctSenders: 2 },
      last24h: { payments: 3, amount: 60500, distinctSenders: 2 },
      watchlist: null,
    });
    expect(res.body.data.riskMix.LOW + res.body.data.riskMix.MEDIUM + res.body.data.riskMix.HIGH + res.body.data.riskMix.CRITICAL).toBe(3);
    expect(res.body.data.recentPayments).toHaveLength(3);
    expect(res.body.data.recentPayments[0].amount).toBe(60000); // newest first
    expect(res.body.data.recentPayments.map((p) => p.customer.name).sort()).toEqual(['Asha', 'Bala', 'Bala']);
    expect(await AuditLogModel.countDocuments({ action: 'PAYEE_VIEWED', entityId: `vpa:${MULE}` })).toBe(1);
  });

  it('404 for an unknown payee, 200 for a payee that is only on the watchlist, 422 for a bad key', async () => {
    const { agent } = await analyst();
    expect((await agent.get('/analyst-api/payees/profile').query({ key: 'vpa:nobody01@ybl' })).status).toBe(404);

    await agent.post('/analyst-api/payees/watchlist').send({ vpa: MULE });
    const listedOnly = await agent.get('/analyst-api/payees/profile').query({ key: `vpa:${MULE}` });
    expect(listedOnly.status).toBe(200);
    expect(listedOnly.body.data.totals.payments).toBe(0);
    expect(listedOnly.body.data.watchlist).toMatchObject({ active: true });

    for (const key of ['', MULE, 'vpa:BAD@YBL']) {
      expect((await agent.get('/analyst-api/payees/profile').query({ key })).status).toBe(422);
    }
    expect((await agent.get('/analyst-api/payees/profile?key[$ne]=x')).status).toBe(422);
  });

  it('the flagged list carries payee and signals', async () => {
    const c = await customer();
    await pay(c.agent, highRisk({ payeeVpa: MULE }));
    const { agent } = await analyst();
    const res = await agent.get('/analyst-api/flagged-transactions');
    expect(res.status).toBe(200);
    expect(res.body.data[0].payee).toEqual({ key: `vpa:${MULE}`, vpa: MULE });
    expect(res.body.data[0].payeeSignals).toMatchObject({ firstTimePayee: true, watchlisted: false });
  });
});

describe('db:backfill-payees', () => {
  it('sets the merchant payee on older payments once and leaves the rest alone', async () => {
    const { user } = await seedUser({ email: uniqueEmail('bf') });
    const oldA = await seedTransaction({ userId: user._id, merchantName: '  Old   Shop ' });
    const oldB = await seedTransaction({ userId: user._id, merchantName: 'Tea Stall' });
    const modern = await seedTransaction({ userId: user._id, merchantName: 'X', payee: { key: `vpa:${MULE}`, vpa: MULE } });

    const lines = [];
    expect(await backfillPayees((l) => lines.push(l))).toEqual({ scanned: 2, updated: 2 });
    expect(lines[0]).toMatch(/2 payment\(s\) without a payee found, 2 updated/);
    expect((await TransactionModel.findById(oldA._id).lean()).payee).toEqual({ key: 'merchant:old shop' });
    expect((await TransactionModel.findById(oldB._id).lean()).payee).toEqual({ key: 'merchant:tea stall' });
    expect((await TransactionModel.findById(modern._id).lean()).payee).toEqual({ key: `vpa:${MULE}`, vpa: MULE });
    expect((await TransactionModel.findById(oldA._id).lean()).payeeSignals).toBeUndefined();

    expect(await backfillPayees(() => {})).toEqual({ scanned: 0, updated: 0 }); // second run: nothing to do
  });
});
