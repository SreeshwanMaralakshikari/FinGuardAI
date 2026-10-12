// tests/round1.api.test.js — fix round 1 (audit items E-xx / C-xx / D-xx), API level.
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import app from '../app.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin, seedAnalyst } from './helpers/seedUser.js';
import { seedConfig } from './helpers/seedConfig.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { itAtomic } from './helpers/dbAtomicity.js';
import { loginAgent, createAgent } from './helpers/authAgent.js';
import UserModel from '../models/UserModel.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import NotificationModel from '../models/NotificationModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import { socketAuthMiddleware } from '../utils/socketAuth.js';
import { getZonedParts } from '../config/timeZone.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

let counter = 0;
const uniq = () => { counter += 1; return `${Date.now()}_${counter}`; };
const MUMBAI = { city: 'Mumbai', country: 'IN' };
const txnBody = (o = {}) => ({
  amount: 500, merchantName: 'BookStore', merchantCategory: 'RETAIL', paymentMethod: 'UPI',
  location: MUMBAI, deviceId: `dev-${uniq()}`, ...o,
});
const tokenFrom = (res) => /token=([^;]+)/.exec((res.headers['set-cookie'] ?? []).join(';'))?.[1];

async function customer(overrides = {}) {
  const { user, password } = await seedUser({ email: `c${uniq()}@test.com`, ...overrides });
  return { user, password, agent: await loginAgent(user.email, password) };
}
async function admin() {
  const { user, password } = await seedAdmin({ email: `a${uniq()}@test.com` });
  return { user, agent: await loginAgent(user.email, password) };
}
async function analyst() {
  const { user, password } = await seedAnalyst({ email: `an${uniq()}@test.com` });
  return { user, agent: await loginAgent(user.email, password) };
}

// ── E-01 / C-09 ───────────────────────────────────────────────────────────────────
describe('E-01 a deactivated user\'s live session is a 401 with a code', () => {
  it('every authenticated route answers 401 ACCOUNT_DEACTIVATED (not 403)', async () => {
    const { user, agent } = await customer();
    await UserModel.updateOne({ _id: user._id }, { isActive: false });
    for (const res of [await agent.get('/customer-api/profile'), await agent.get('/notification-api/notifications'), await agent.get('/auth/check-auth')]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, message: 'Account has been deactivated. Contact support.', code: 'ACCOUNT_DEACTIVATED' });
    }
  });

  it('logout of such a session still removes the cookie', async () => {
    const { user, agent } = await customer();
    await UserModel.updateOne({ _id: user._id }, { isActive: false });
    const res = await agent.post('/auth/logout');
    expect(res.status).toBe(401);
    expect((res.headers['set-cookie'] ?? []).some((c) => /^token=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
  });

  it('other 401s carry no code; /auth/login for a deactivated user stays 403', async () => {
    const none = await createAgent().get('/customer-api/profile');
    expect(none.status).toBe(401);
    expect(none.body).not.toHaveProperty('code');
    const { user, password } = await seedUser({ email: `off${uniq()}@test.com`, isActive: false });
    expect((await createAgent().post('/auth/login').send({ email: user.email, password })).status).toBe(403);
  });
});

describe('C-09 re-activation does not revive old sessions', () => {
  it('deactivate → reactivate → the old cookie is 401, a new login works', async () => {
    const { agent: adminAgent } = await admin();
    const { user, password } = await seedUser({ email: `rev${uniq()}@test.com` });
    const first = await createAgent().post('/auth/login').send({ email: user.email, password });
    const oldCookie = `token=${tokenFrom(first)}`;
    const oldAgent = () => createAgent().set('Cookie', oldCookie);
    expect((await oldAgent().get('/auth/check-auth')).status).toBe(200);

    expect((await adminAgent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: false })).status).toBe(200);
    expect((await oldAgent().get('/auth/check-auth')).body.code).toBe('ACCOUNT_DEACTIVATED');

    await new Promise((r) => setTimeout(r, 5)); // the new token must be issued after the deactivation instant
    expect((await adminAgent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: true })).status).toBe(200);

    const stale = await oldAgent().get('/auth/check-auth');
    expect(stale.status).toBe(401);
    expect(stale.body.message).toMatch(/Session expired/);

    const fresh = await createAgent().post('/auth/login').send({ email: user.email, password });
    expect(fresh.status).toBe(200);
    expect((await createAgent().set('Cookie', `token=${tokenFrom(fresh)}`).get('/auth/check-auth')).status).toBe(200);
  });

  it('the WebSocket handshake rejects the old token after re-activation too', async () => {
    const { agent: adminAgent } = await admin();
    const { user } = await seedUser({ email: `sock${uniq()}@test.com` });
    const sign = () => jwt.sign({ id: String(user._id), iatMs: Date.now() }, process.env.JWT_SECRET, { expiresIn: '6h' });
    const handshake = async (token) => {
      const socket = { handshake: { headers: { cookie: `token=${token}` } }, data: {} };
      return new Promise((resolve) => socketAuthMiddleware(socket, resolve));
    };
    const old = sign();
    expect(await handshake(old)).toBeUndefined();
    await adminAgent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: false });
    await new Promise((r) => setTimeout(r, 5));
    await adminAgent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: true });
    expect((await handshake(old)).message).toBe('UNAUTHENTICATED');
    expect(await handshake(sign())).toBeUndefined();
  });

  it('sessionsRevokedAt is stored on deactivation and never serialised', async () => {
    const { agent: adminAgent } = await admin();
    const { user } = await seedUser({ email: `st${uniq()}@test.com` });
    const res = await adminAgent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: false });
    expect(JSON.stringify(res.body)).not.toMatch(/sessionsRevokedAt/);
    expect((await UserModel.findById(user._id).select('+sessionsRevokedAt')).sessionsRevokedAt).toBeInstanceOf(Date);
    const list = await adminAgent.get('/admin-api/users');
    expect(JSON.stringify(list.body)).not.toMatch(/sessionsRevokedAt|passwordChangedAt|"password"|__v/);
  });
});

// ── E-04 / E-09 / C-06: fraud patterns ───────────────────────────────────────────────
describe('E-04 fraud-pattern clusters show the NEWEST 10 transactions', () => {
  it('12 HIGH transactions on one device / IP / merchant: the 10 newest, newest first', async () => {
    const { user } = await seedUser({ email: `fp${uniq()}@test.com` });
    const { agent } = await analyst();
    const base = Date.parse('2026-09-01T10:00:00Z');
    // inserted newest-first, so storage order is the REVERSE of time order
    for (const i of [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
      await seedTransaction({
        userId: user._id, amount: 1000 + i, riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD',
        deviceId: 'dev-cluster', ipAddress: '203.0.113.9', merchantName: 'Shady Shop', timestamp: new Date(base + i * 60_000),
      });
    }
    const { sharedDeviceClusters, sharedIpClusters, highRiskMerchantClusters } = (await agent.get('/analyst-api/fraud-patterns')).body.data;
    const expected = [1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004, 1003, 1002];
    for (const cluster of [sharedDeviceClusters[0], sharedIpClusters[0], highRiskMerchantClusters[0]]) {
      expect(cluster.count).toBe(12);
      expect(cluster.transactions.map((t) => t.amount)).toEqual(expected);
    }
  });
});

describe('E-09 case / whitespace-insensitive grouping', () => {
  it('admin fraudByLocation merges Mumbai / mumbai / " MUMBAI " and labels with the newest spelling', async () => {
    const { user } = await seedUser({ email: `g${uniq()}@test.com` });
    const { agent } = await admin();
    const base = Date.parse('2026-09-01T10:00:00Z');
    const mk = (city, i) => seedTransaction({
      userId: user._id, riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD',
      location: { city, country: 'IN' }, timestamp: new Date(base + i * 60_000),
    });
    await mk('Mumbai', 0); await mk('mumbai', 1); await mk('MUMBAI', 2); await mk('Delhi', 3);
    const { fraudByLocation } = (await agent.get('/admin-api/analytics')).body.data;
    expect(fraudByLocation).toHaveLength(2);
    expect(fraudByLocation[0].count).toBe(3);
    expect(fraudByLocation[0].city.toLowerCase()).toBe('mumbai');
    expect(fraudByLocation[0].city).toBe('MUMBAI'); // newest transaction's spelling
    expect(fraudByLocation[1]).toMatchObject({ city: 'Delhi', count: 1 });
  });

  it('analyst merchant clusters reach the >= 3 threshold across spellings', async () => {
    const { user } = await seedUser({ email: `m${uniq()}@test.com` });
    const { agent } = await analyst();
    const base = Date.parse('2026-09-01T10:00:00Z');
    const names = ['Shady Shop', 'shady shop', ' SHADY SHOP '];
    for (const [i, merchantName] of names.entries()) {
      await seedTransaction({ userId: user._id, riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD', merchantName, timestamp: new Date(base + i * 60_000), deviceId: `d${i}` });
    }
    const { highRiskMerchantClusters } = (await agent.get('/analyst-api/fraud-patterns')).body.data;
    expect(highRiskMerchantClusters).toHaveLength(1);
    expect(highRiskMerchantClusters[0]).toMatchObject({ count: 3, userCount: 1 });
    expect(highRiskMerchantClusters[0].merchantName.trim().toLowerCase()).toBe('shady shop');
  });
});

describe('C-06 stable paging and deterministic top-N (_id tie-break)', () => {
  it('customer transactions with identical timestamps page without repeats or gaps', async () => {
    const { user, agent } = await customer();
    const timestamp = new Date('2026-09-01T10:00:00Z');
    for (let i = 0; i < 5; i += 1) await seedTransaction({ userId: user._id, amount: 10 + i, timestamp });
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await agent.get(`/customer-api/transactions?limit=2&page=${page}`);
      seen.push(...res.body.data.map((t) => t.publicId));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // _id descending = newest insert first
    const all = await TransactionModel.find({ userId: user._id }).sort({ _id: -1 });
    expect(seen).toEqual(all.map((t) => t.publicId));
  });

  it('peakFraudHours with equal counts are returned earliest hour first', async () => {
    const { user } = await seedUser({ email: `ph${uniq()}@test.com` });
    const { agent } = await admin();
    const t1 = new Date(Date.now() - 26 * 3600_000);
    const t2 = new Date(Date.now() - 49 * 3600_000 - 20 * 60_000);
    for (const timestamp of [t1, t2]) {
      await seedTransaction({ userId: user._id, riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD', timestamp });
    }
    const hours = [t1, t2].map((d) => getZonedParts(d).hour);
    const { peakFraudHours } = (await agent.get('/admin-api/analytics/trends')).body.data;
    expect(peakFraudHours.map((h) => h.hour)).toEqual([...new Set(hours)].sort((a, b) => a - b));
  });
});

// ── E-05 ───────────────────────────────────────────────────────────────────────────
describe('E-05 analyst visibility is HIGH / CRITICAL only', () => {
  it('detail of a LOW or MEDIUM transaction is 404, HIGH / CRITICAL is 200', async () => {
    const { user } = await seedUser({ email: `v${uniq()}@test.com` });
    const { agent } = await analyst();
    const ids = {};
    for (const riskLevel of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      ids[riskLevel] = (await seedTransaction({ userId: user._id, riskLevel, deviceId: `d-${riskLevel}` }))._id;
    }
    for (const riskLevel of ['LOW', 'MEDIUM']) {
      const res = await agent.get(`/analyst-api/flagged-transactions/${ids[riskLevel]}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/@test\.com/);
    }
    for (const riskLevel of ['HIGH', 'CRITICAL']) {
      expect((await agent.get(`/analyst-api/flagged-transactions/${ids[riskLevel]}`)).status).toBe(200);
    }
  });

  it('POST /cases refuses a MEDIUM alert (400, no case) and accepts HIGH', async () => {
    const { user } = await seedUser({ email: `cs${uniq()}@test.com` });
    const { agent } = await analyst();
    const alertFor = async (riskLevel) => {
      const transaction = await seedTransaction({ userId: user._id, riskLevel, deviceId: `d-${riskLevel}-${uniq()}` });
      return FraudAlertModel.create({ transactionId: transaction._id, userId: user._id, alertType: 'COMPOSITE', riskLevel, fraudScore: 60, reasons: [] });
    };
    const medium = await alertFor('MEDIUM');
    const refused = await agent.post('/analyst-api/cases').send({ fraudAlertId: String(medium._id) });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/HIGH or CRITICAL/);
    expect(await FraudCaseModel.countDocuments({})).toBe(0);
    expect((await FraudAlertModel.findById(medium._id)).status).toBe('OPEN');
    const high = await alertFor('HIGH');
    expect((await agent.post('/analyst-api/cases').send({ fraudAlertId: String(high._id) })).status).toBe(201);
  });
});

// ── E-06 / E-07 / E-08 ──────────────────────────────────────────────────────────────
describe('E-06 location is required', () => {
  it('missing location, missing / empty city → 422; country stays optional (default IN)', async () => {
    const { agent, user } = await customer();
    const { location: _omit, ...withoutLocation } = txnBody();
    const missing = await agent.post('/customer-api/transactions').send(withoutLocation);
    expect(missing.status).toBe(422);
    expect(missing.body.message).toMatch(/Location must be an object/);
    const noCity = await agent.post('/customer-api/transactions').send(txnBody({ location: { country: 'IN' } }));
    expect(noCity.status).toBe(422);
    expect(noCity.body.message).toMatch(/Location city is required/);
    expect((await agent.post('/customer-api/transactions').send(txnBody({ location: {} }))).status).toBe(422);
    expect((await agent.post('/customer-api/transactions').send(txnBody({ location: { city: '   ' } }))).status).toBe(422);
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(0);
    const ok = await agent.post('/customer-api/transactions').send(txnBody({ location: { city: ' Pune ' } }));
    expect(ok.status).toBe(201);
    expect((await TransactionModel.findById(ok.body.data.id)).location.toObject()).toEqual({ city: 'Pune', country: 'IN' });
  });
});

describe('E-07 amount: 0.01 – 1e9, two decimals', () => {
  const amountCases = [
    [0.009, 422], ['0.009', 422], [0.005, 422], [0, 422], [-1, 422], [1_000_000_000.01, 422], [1_000_000_001, 422],
  ];
  it('rejects amounts below 0.01 or above 1e9 with an accurate message', async () => {
    const { agent, user } = await customer();
    for (const [amount, status] of amountCases) {
      const res = await agent.post('/customer-api/transactions').send(txnBody({ amount }));
      expect(res.status).toBe(status);
      expect(res.body.message).toBe('Amount must be at least ₹0.01 and at most ₹1,00,00,00,000');
      expect(res.body.errors[0]).toMatchObject({ type: 'field', path: 'amount', location: 'body' });
    }
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(0);
  });

  it('accepts the boundaries and rounds to 2 decimals', async () => {
    const results = {};
    for (const amount of ['0.01', 0.014, 100.123456789, '19.999', 1_000_000_000]) {
      const { agent } = await customer(); // the per-account submit limiter is 30/min; one customer each keeps it simple
      const res = await agent.post('/customer-api/transactions').send(txnBody({ amount }));
      expect(res.status).toBe(201);
      results[String(amount)] = res.body.data.amount;
      expect((await TransactionModel.findById(res.body.data.id)).amount).toBe(res.body.data.amount);
    }
    expect(results).toEqual({ '0.01': 0.01, '0.014': 0.01, '100.123456789': 100.12, '19.999': 20, '1000000000': 1_000_000_000 });
  });
});

describe('E-08 array / object ids never reach Mongoose', () => {
  it('fraudAlertId as array or object is a clean 422 with no model names', async () => {
    const { user } = await seedUser({ email: `e8${uniq()}@test.com` });
    const { agent } = await analyst();
    const transaction = await seedTransaction({ userId: user._id, riskLevel: 'HIGH' });
    const alert = await FraudAlertModel.create({ transactionId: transaction._id, userId: user._id, alertType: 'COMPOSITE', riskLevel: 'HIGH', fraudScore: 60, reasons: [] });
    const id = String(alert._id);
    for (const fraudAlertId of [[id], [id, id], { $gt: '' }, 123, null]) {
      const res = await agent.post('/analyst-api/cases').send({ fraudAlertId });
      expect(res.status).toBe(422);
      expect(res.body.message).toBe('A valid fraud alert ID is required');
      expect(JSON.stringify(res.body)).not.toMatch(/Cast to|FraudCase/);
    }
    expect(await FraudCaseModel.countDocuments({})).toBe(0);
    expect((await agent.post('/analyst-api/cases').send({ fraudAlertId: id })).status).toBe(201);
  });
});

// ── E-10 ───────────────────────────────────────────────────────────────────────────
describe('E-10 impossible date-times are a 400 (not a rolled-over window)', () => {
  it('rejects bad hour / minute / second / calendar day, zoneless and Z / offset', async () => {
    const { agent } = await customer();
    const bad = [
      '2026-10-05T25:00', '2026-10-05T24:00', '2026-10-05T10:99', '2026-10-05T10:00:60', '2026-02-30T10:00',
      '2026-02-30T10:00:00Z', '2026-10-05T25:00:00Z', '2026-10-05T10:60:00+05:30', '2026-13-01T10:00:00Z',
      '2026-10-05T10:00:00+25:00', '2026-10-05T10:00:00+05:61',
    ];
    for (const startDate of bad) {
      const res = await agent.get('/customer-api/transactions').query({ startDate });
      expect([startDate, res.status]).toEqual([startDate, 400]);
      expect(res.body.message).toMatch(/Invalid startDate/);
    }
    const good = ['2026-10-05T23:59', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00.123+05:30', '2026-10-05T10:00:00+0530', '2026-02-28T10:00'];
    for (const endDate of good) {
      expect([endDate, (await agent.get('/customer-api/transactions').query({ endDate })).status]).toEqual([endDate, 200]);
    }
  });
});

// ── E-13 ───────────────────────────────────────────────────────────────────────────
describe('E-13 assigning a case notifies only the analyst who lost it', () => {
  it('self-assign: no notification; take-over: the previous analyst is told, the new one is not', async () => {
    const { user } = await seedUser({ email: `n${uniq()}@test.com` });
    const alice = await analyst();
    const bob = await analyst();
    const transaction = await seedTransaction({ userId: user._id, riskLevel: 'HIGH', status: 'HELD' });
    const alert = await FraudAlertModel.create({ transactionId: transaction._id, userId: user._id, alertType: 'COMPOSITE', riskLevel: 'HIGH', fraudScore: 60, reasons: [] });
    const created = await alice.agent.post('/analyst-api/cases').send({ fraudAlertId: String(alert._id) });
    const caseId = created.body.data._id;
    expect((await alice.agent.patch(`/analyst-api/cases/${caseId}/assign`).send({})).status).toBe(200);
    expect(await NotificationModel.countDocuments({ recipientId: alice.user._id })).toBe(0);
    expect((await bob.agent.patch(`/analyst-api/cases/${caseId}/assign`).send({})).status).toBe(200);
    expect(await NotificationModel.countDocuments({ recipientId: bob.user._id })).toBe(0);
    const told = await NotificationModel.find({ recipientId: alice.user._id });
    expect(told).toHaveLength(1);
    expect(told[0].type).toBe('CASE_STATUS_CHANGED');
  });
});

// ── E-14 ───────────────────────────────────────────────────────────────────────────
describe('E-14 invalid query filters are a 422 in the standard validation shape', () => {
  const expect422 = (res, path) => {
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(res.body.errors[0].msg);
    expect(res.body.errors[0]).toMatchObject({ type: 'field', path, location: 'query' });
  };

  it('admin: users and audit logs', async () => {
    const { agent } = await admin();
    expect422(await agent.get('/admin-api/users?isActive=banana'), 'isActive');
    expect422(await agent.get('/admin-api/users?role=BOSS'), 'role');
    expect422(await agent.get('/admin-api/users?role=ADMIN&role=ANALYST'), 'role'); // repeated key → array
    expect422(await agent.get('/admin-api/audit-logs?actorRole=nobody'), 'actorRole');
    for (const ok of ['', '?isActive=true', '?isActive=false', '?isActive=', '?role=ANALYST', '?role=&isActive=']) {
      expect([ok, (await agent.get(`/admin-api/users${ok}`)).status]).toEqual([ok, 200]);
    }
    expect((await agent.get('/admin-api/audit-logs?actorRole=ADMIN')).status).toBe(200);
    expect((await agent.get('/admin-api/audit-logs?actorId=not-an-id')).status).toBe(400); // unchanged behaviour
  });

  it('admin: isActive filter still filters correctly', async () => {
    const { agent } = await admin();
    await seedUser({ email: `on${uniq()}@test.com` });
    await seedUser({ email: `off${uniq()}@test.com`, isActive: false });
    expect((await agent.get('/admin-api/users?isActive=false')).body.data.every((u) => u.isActive === false)).toBe(true);
    expect((await agent.get('/admin-api/users?isActive=true')).body.data.every((u) => u.isActive === true)).toBe(true);
  });

  it('notifications: isRead', async () => {
    const { agent, user } = await customer();
    await NotificationModel.create({ recipientId: user._id, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: 't', message: 'm', relatedEntityId: user._id, relatedEntityType: 'FRAUD_ALERT', isRead: true });
    await NotificationModel.create({ recipientId: user._id, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: 't2', message: 'm', relatedEntityId: user._id, relatedEntityType: 'FRAUD_ALERT' });
    expect422(await agent.get('/notification-api/notifications?isRead=banana'), 'isRead');
    expect((await agent.get('/notification-api/notifications?isRead=true')).body.data).toHaveLength(1);
    expect((await agent.get('/notification-api/notifications?isRead=false')).body.data).toHaveLength(1);
    expect((await agent.get('/notification-api/notifications')).body.data).toHaveLength(2);
  });

  it('customer: transactions and alerts', async () => {
    const { agent } = await customer();
    expect422(await agent.get('/customer-api/transactions?riskLevel=x'), 'riskLevel');
    expect422(await agent.get('/customer-api/transactions?paymentMethod=CASH'), 'paymentMethod');
    expect422(await agent.get('/customer-api/fraud-alerts?status=garbage'), 'status');
    expect422(await agent.get('/customer-api/fraud-alerts?riskLevel=x'), 'riskLevel');
    expect422(await agent.get('/customer-api/fraud-alerts?status=OPEN&status=DISMISSED'), 'status');
    expect((await agent.get('/customer-api/transactions?riskLevel=HIGH&paymentMethod=UPI')).status).toBe(200);
    expect((await agent.get('/customer-api/transactions?riskLevel=&paymentMethod=')).status).toBe(200);
    expect((await agent.get('/customer-api/fraud-alerts?status=OPEN&riskLevel=CRITICAL')).status).toBe(200);
  });

  it('analyst: flagged transactions and cases', async () => {
    const { agent } = await analyst();
    expect422(await agent.get('/analyst-api/flagged-transactions?riskLevel=LOW'), 'riskLevel');
    expect422(await agent.get('/analyst-api/flagged-transactions?riskLevel=MEDIUM'), 'riskLevel');
    expect422(await agent.get('/analyst-api/cases?status=garbage'), 'status');
    expect422(await agent.get('/analyst-api/cases?assignedToMe=maybe'), 'assignedToMe');
    for (const ok of ['?riskLevel=HIGH', '?riskLevel=CRITICAL', '?riskLevel=']) {
      expect((await agent.get(`/analyst-api/flagged-transactions${ok}`)).status).toBe(200);
    }
    expect((await agent.get('/analyst-api/cases?status=OPEN&assignedToMe=true')).status).toBe(200);
    expect((await agent.get('/analyst-api/cases?assignedToMe=false')).status).toBe(200);
  });
});

// ── E-16 ───────────────────────────────────────────────────────────────────────────
describe('E-16 thresholds PATCH is compare-and-set', () => {
  const stored = () => SystemConfigModel.findOne({ singleton: 'system' }).lean();
  afterEach(() => jest.restoreAllMocks());

  it('a stale read is detected, re-read once, and the update then succeeds', async () => {
    const { agent } = await admin();
    // The first read returns values that are no longer in the database (another admin changed them).
    const staleConfig = { scoreThresholds: { mediumMin: 20, highMin: 40, criticalMin: 80 }, velocityLimit: { maxPerHour: 5, maxPerDay: 20 } };
    const spy = jest.spyOn(SystemConfigModel, 'findOne').mockImplementationOnce(() => ({ lean: async () => staleConfig }));
    const res = await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { highMin: 60 } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2); // stale read → guarded write missed → fresh read → write
    expect((await stored()).scoreThresholds).toEqual({ mediumMin: 25, highMin: 60, criticalMin: 75 });
  });

  it('two stale reads in a row → 409 and nothing is written', async () => {
    const { agent } = await admin();
    const staleConfig = { scoreThresholds: { mediumMin: 20, highMin: 40, criticalMin: 80 }, velocityLimit: { maxPerHour: 5, maxPerDay: 20 } };
    jest.spyOn(SystemConfigModel, 'findOne').mockImplementation(() => ({ lean: async () => staleConfig }));
    const res = await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { highMin: 60 } });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    jest.restoreAllMocks();
    expect((await stored()).scoreThresholds).toEqual({ mediumMin: 25, highMin: 50, criticalMin: 75 });
    expect(await AuditLogModel.countDocuments({ action: 'THRESHOLDS_UPDATED' })).toBe(0);
  });

  it('velocityLimit is guarded the same way; fields outside the guard do not conflict', async () => {
    const { agent } = await admin();
    const stale = { velocityLimit: { maxPerHour: 9, maxPerDay: 9 }, scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 } };
    jest.spyOn(SystemConfigModel, 'findOne').mockImplementation(() => ({ lean: async () => stale }));
    expect((await agent.patch('/admin-api/thresholds').send({ velocityLimit: { maxPerDay: 30 } })).status).toBe(409);
    expect((await agent.patch('/admin-api/thresholds').send({ amountThreshold: 12345 })).status).toBe(200); // no cross-field rule involved
    jest.restoreAllMocks();
    expect((await stored()).amountThreshold).toBe(12345);
    expect((await stored()).velocityLimit).toMatchObject({ maxPerHour: 5, maxPerDay: 20 });
  });

  itAtomic('two admins racing on the ordering never store an invalid combination', async () => {
    const [a, b] = [await admin(), await admin()];
    const results = await Promise.all([
      a.agent.patch('/admin-api/thresholds').send({ scoreThresholds: { highMin: 40 } }),
      b.agent.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: 45 } }),
    ]);
    for (const r of results) expect([200, 409, 422]).toContain(r.status);
    const { mediumMin, highMin, criticalMin } = (await stored()).scoreThresholds;
    expect(mediumMin < highMin && highMin < criticalMin).toBe(true);
  });
});

// ── C-02 ───────────────────────────────────────────────────────────────────────────
describe('C-02 one alert per transaction; the insert retry is idempotent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the unique index rejects a second alert for the same transaction', async () => {
    const { user } = await seedUser({ email: `u${uniq()}@test.com` });
    const transaction = await seedTransaction({ userId: user._id, riskLevel: 'HIGH' });
    const doc = { transactionId: transaction._id, userId: user._id, alertType: 'COMPOSITE', riskLevel: 'HIGH', fraudScore: 60, reasons: [] };
    await FraudAlertModel.create(doc);
    await expect(FraudAlertModel.create(doc)).rejects.toMatchObject({ code: 11000 });
  });

  it('first insert succeeds but reports an error → retry returns the existing alert (one alert, one notification)', async () => {
    const { agent, user } = await customer();
    const realCreate = FraudAlertModel.create.bind(FraudAlertModel);
    jest.spyOn(FraudAlertModel, 'create').mockImplementationOnce(async (doc) => {
      await realCreate(doc); // the write really happened…
      throw new Error('connection reset before the reply'); // …but the caller never saw the result
    });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await agent.post('/customer-api/transactions').send(txnBody({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO' }));
    quiet.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.data.fraudAlert).toHaveProperty('id');
    expect(await FraudAlertModel.countDocuments({ userId: user._id })).toBe(1);
    const stored = await FraudAlertModel.findOne({ userId: user._id });
    expect(String(stored._id)).toBe(String(res.body.data.fraudAlert.id));
    expect(await NotificationModel.countDocuments({ recipientId: user._id, type: 'FRAUD_ALERT' })).toBe(1);
  });
});

// ── C-05 ───────────────────────────────────────────────────────────────────────────
describe('C-05 index clean-up', () => {
  const keys = async (Model) => (await Model.collection.indexes()).map((i) => JSON.stringify(i.key));
  it('drops the three unused indexes and adds the two that serve real queries', async () => {
    const DeviceReputationModel = (await import('../models/DeviceReputationModel.js')).default;
    const user = await keys(UserModel);
    const transaction = await keys(TransactionModel);
    const device = await keys(DeviceReputationModel);
    expect(user).toContain('{"createdAt":-1}');
    expect(user).not.toContain('{"email":1,"role":1}');
    expect(user).toContain('{"email":1}'); // unique login lookup stays
    expect(transaction).toContain('{"status":1,"timestamp":-1}');
    expect(transaction).not.toContain('{"riskLevel":1,"status":1}');
    expect(device).not.toContain('{"reputationScore":1}');
    expect(device).toContain('{"deviceId":1}');
  });

  it('keeps every index that serves an actual query', async () => {
    const AuditLog = AuditLogModel;
    expect(await keys(TransactionModel)).toEqual(expect.arrayContaining(['{"userId":1,"timestamp":-1}', '{"deviceId":1}', '{"riskLevel":1,"timestamp":-1}']));
    expect(await keys(FraudAlertModel)).toEqual(expect.arrayContaining(['{"userId":1,"status":1}', '{"riskLevel":1,"createdAt":-1}', '{"transactionId":1}']));
    expect(await keys(FraudCaseModel)).toEqual(expect.arrayContaining(['{"status":1,"assignedAnalystId":1}', '{"fraudAlertId":1}', '{"transactionId":1}']));
    expect(await keys(AuditLog)).toEqual(expect.arrayContaining(['{"actorId":1,"timestamp":-1}', '{"entityType":1,"entityId":1}', '{"timestamp":-1}']));
    const NotificationIdx = await keys(NotificationModel);
    expect(NotificationIdx).toContain('{"recipientId":1,"isRead":1,"createdAt":-1}');
  });
});

// ── D-05 ───────────────────────────────────────────────────────────────────────────
describe('D-05 whitespace-only passwords', () => {
  it('register and change-password reject a password with no visible character', async () => {
    const register = (password) => createAgent().post('/auth/register').send({ name: 'Space Case', email: `sp${uniq()}@test.com`, password, role: 'CUSTOMER' });
    const blank = await register('        ');
    expect(blank.status).toBe(422);
    expect(blank.body.message).toMatch(/not a space/);
    expect((await register(' \t \t \t ')).status).toBe(422);
    expect((await register('pass word 1')).status).toBe(201); // inner spaces are fine
    expect((await register('       a')).status).toBe(201);

    const { agent, user } = await customer();
    const change = await agent.patch('/auth/change-password').send({ currentPassword: 'Password@123', newPassword: '          ' });
    expect(change.status).toBe(422);
    expect(change.body.message).toMatch(/not a space/);
    expect(await UserModel.countDocuments({ _id: user._id })).toBe(1);
  });
});

// ── D-06 / D-07 ──────────────────────────────────────────────────────────────────────
describe('D-06 CORS exposes the rate-limit headers', () => {
  it('Access-Control-Expose-Headers lists RateLimit-* and Retry-After', async () => {
    const res = await supertest(app).get('/health').set('Origin', 'http://localhost:3000');
    const exposed = res.headers['access-control-expose-headers'];
    expect(exposed).toBeDefined();
    for (const name of ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']) expect(exposed).toContain(name);
  });
});

describe('D-07 authenticated API responses are not cacheable', () => {
  it('Cache-Control: no-store on every authenticated prefix, success and error alike', async () => {
    const { agent } = await customer();
    for (const path of ['/auth/check-auth', '/customer-api/profile', '/notification-api/notifications']) {
      expect([path, (await agent.get(path)).headers['cache-control']]).toEqual([path, 'no-store']);
    }
    for (const path of ['/analyst-api/cases', '/admin-api/users', '/customer-api/transactions']) {
      const res = await createAgent().get(path); // 401 without a cookie
      expect([path, res.status, res.headers['cache-control']]).toEqual([path, 401, 'no-store']);
    }
    expect((await agent.get('/analyst-api/cases')).headers['cache-control']).toBe('no-store'); // 403 too
    expect((await supertest(app).get('/health')).headers['cache-control']).toBe('no-store');
  });
});

// ── D-09 ───────────────────────────────────────────────────────────────────────────
describe('D-09 audit log is append-only through the model', () => {
  it('every update / delete path is refused, inserts and reads still work, collection-level cleanup works', async () => {
    const { user } = await seedUser({ email: `al${uniq()}@test.com` });
    const entry = await AuditLogModel.create({ actorId: user._id, actorRole: 'CUSTOMER', action: 'PROFILE_UPDATED', entityType: 'User', entityId: String(user._id) });
    const id = entry._id;
    const refused = /immutable/;
    await expect(AuditLogModel.updateOne({ _id: id }, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.updateMany({}, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.findOneAndUpdate({ _id: id }, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.findByIdAndUpdate(id, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.findOneAndReplace({ _id: id }, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.replaceOne({ _id: id }, { action: 'PROFILE_UPDATED' })).rejects.toThrow(refused);
    await expect(AuditLogModel.deleteOne({ _id: id })).rejects.toThrow(refused);
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(refused);
    await expect(AuditLogModel.findOneAndDelete({ _id: id })).rejects.toThrow(refused);
    await expect(AuditLogModel.findByIdAndDelete(id)).rejects.toThrow(refused);
    await expect(AuditLogModel.bulkWrite([{ deleteOne: { filter: { _id: id } } }])).rejects.toThrow(refused);
    const loaded = await AuditLogModel.findById(id);
    loaded.action = 'USER_LOGIN';
    await expect(loaded.save()).rejects.toThrow(refused);
    await expect(loaded.deleteOne()).rejects.toThrow(refused);

    const untouched = await AuditLogModel.findById(id);
    expect(untouched.action).toBe('PROFILE_UPDATED');
    expect(await AuditLogModel.countDocuments({})).toBe(1);

    // still allowed: append, read, bulk insert, and the test cleanup at collection level
    await AuditLogModel.create({ actorId: user._id, actorRole: 'CUSTOMER', action: 'PROFILE_UPDATED', entityType: 'User', entityId: 'x' });
    await AuditLogModel.bulkWrite([{ insertOne: { document: { actorId: user._id, actorRole: 'CUSTOMER', action: 'USER_LOGOUT', entityType: 'User', entityId: 'x' } } }]);
    expect(await AuditLogModel.countDocuments({})).toBe(3);
    await AuditLogModel.collection.deleteMany({});
    expect(await AuditLogModel.countDocuments({})).toBe(0);
  });
});

// ── D-03 (HTTP level) ──────────────────────────────────────────────────────────────────
describe('D-03 secure by default: a missing NODE_ENV behaves like production', () => {
  let saved;
  beforeEach(() => { saved = process.env.NODE_ENV; });
  afterEach(() => { process.env.NODE_ENV = saved; });

  it('login cookie is Secure / SameSite=None when NODE_ENV is unset, and relaxed for development', async () => {
    const { user, password } = await seedUser({ email: `env${uniq()}@test.com` });
    delete process.env.NODE_ENV;
    const secure = await createAgent().post('/auth/login').send({ email: user.email, password });
    const cookie = secure.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=None/);
    process.env.NODE_ENV = 'development';
    const relaxed = await createAgent().post('/auth/login').send({ email: user.email, password });
    expect(relaxed.headers['set-cookie'].join(';')).not.toMatch(/Secure/);
  });

  it('500 responses hide err.message unless NODE_ENV is development or test', async () => {
    const boom = new Error('secret internal detail');
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { default: errorHandler } = await import('../middleware/errorHandler.js');
    const call = (env) => {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      let body;
      errorHandler(boom, {}, { headersSent: false, status: () => ({ json: (b) => { body = b; } }) }, () => {});
      return body.message;
    };
    expect(call(undefined)).toBe('Internal server error.');
    expect(call('staging')).toBe('Internal server error.');
    expect(call('production')).toBe('Internal server error.');
    expect(call('development')).toBe('secret internal detail');
    expect(call('test')).toBe('secret internal detail');
    quiet.mockRestore();
  });

  it('CORS: localhost origins are only allowed for development / test', async () => {
    const { getAllowedOrigins } = await import('../config/corsOptions.js');
    const frontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.example.com';
    try {
      delete process.env.NODE_ENV;
      expect(getAllowedOrigins()).toEqual(['https://app.example.com']);
      process.env.NODE_ENV = 'development';
      expect(getAllowedOrigins()).toContain('http://localhost:3000');
      process.env.NODE_ENV = 'test';
      expect(getAllowedOrigins()).toContain('http://localhost:3000');
    } finally {
      process.env.FRONTEND_URL = frontend;
    }
  });
});
