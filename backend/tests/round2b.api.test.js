// tests/round2b.api.test.js — fix round 2b (backend)
//   A-01 analytics · A-02 timeline · A-04 forecast · B-07 preview · F-02 acknowledge · A-08 simulation ·
//   D-02 login throttle · C-08 device cap · OPS sync-indexes + allowDiskUse
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin, seedAnalyst, uniqueEmail } from './helpers/seedUser.js';
import { seedConfig } from './helpers/seedConfig.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { createAgent, loginAgent } from './helpers/authAgent.js';
import { freezeClock, unfreezeClock } from './helpers/frozenClock.js';
import UserModel from '../models/UserModel.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import NotificationModel from '../models/NotificationModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import { processTransaction } from '../services/transactionService.js';
import { countOtherDevices } from '../utils/deviceCap.js';
import { syncAllIndexes } from '../seed/syncIndexes.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });
afterEach(() => { unfreezeClock(); jest.restoreAllMocks(); });

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────
async function adminAgent() {
  const { user, password } = await seedAdmin({ email: uniqueEmail('adm') });
  return { user, agent: await loginAgent(user.email, password) };
}
async function customer(prefix = 'c') {
  const { user, password } = await seedUser({ email: uniqueEmail(prefix) });
  return { user, agent: await loginAgent(user.email, password) };
}
async function analyst(name = 'Alice Analyst') {
  const { user, password } = await seedAnalyst({ email: uniqueEmail('an'), name });
  return { user, agent: await loginAgent(user.email, password) };
}

let seq = 0;
/** Insert many transactions at once with explicit public ids (no scoring). */
const bulk = (docs) => TransactionModel.insertMany(docs.map((d) => {
  seq += 1;
  return {
    publicId: `TXN-2026-${String(100000 + seq)}`, amount: 100, merchantName: 'Bulk', merchantCategory: 'RETAIL', paymentMethod: 'UPI',
    deviceId: 'dev-bulk', location: { city: 'Mumbai', country: 'IN' }, fraudScore: 10, riskLevel: 'LOW', recommendedAction: 'APPROVE',
    reasons: [], status: 'APPROVED', timestamp: new Date(), ...d,
  };
}));

const txn = (o = {}) => ({
  amount: 500, merchantName: 'BookStore', merchantCategory: 'RETAIL', paymentMethod: 'UPI',
  location: { city: 'Mumbai', country: 'IN' }, deviceId: 'dev-safe', ...o,
});
const highRisk = txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'CARD', deviceId: 'dev-x' });

const makeAlert = (txnDoc, o = {}) => FraudAlertModel.create({
  transactionId: txnDoc._id, userId: txnDoc.userId, alertType: 'COMPOSITE', riskLevel: 'MEDIUM', fraudScore: 30,
  reasons: ['Unusual city'], status: 'OPEN', ...o,
});

// ── A-01 analytics: fraudByDevice + scoreHistogram ──────────────────────────────────────────────────
describe('A-01 GET /admin-api/analytics', () => {
  it('fraudByDevice: HIGH/CRITICAL only, grouped by device, top 10 by count desc then deviceId, userCount = distinct users', async () => {
    const { agent } = await adminAgent();
    const [u1, u2, u3] = (await Promise.all([seedUser(), seedUser(), seedUser()])).map((r) => r.user._id);
    const rows = [];
    const flagged = (deviceId, userId, riskLevel = 'HIGH') => rows.push({ deviceId, userId, riskLevel, fraudScore: 60, status: 'HELD', recommendedAction: 'HOLD' });
    for (const u of [u1, u1, u2, u2, u2]) flagged('dev-A', u);               // 5 payments, 2 users
    for (let i = 0; i < 5; i += 1) flagged('dev-B', u3, 'CRITICAL');          // 5 payments, 1 user (tie with A → deviceId order)
    for (const id of 'CDEFGHIJKL') flagged(`dev-${id}`, u1);                  // 10 devices with 1 payment each → only 8 fit
    for (let i = 0; i < 9; i += 1) rows.push({ deviceId: 'dev-LOW', userId: u1, riskLevel: i % 2 ? 'LOW' : 'MEDIUM' }); // never listed
    await bulk(rows);

    const res = await agent.get('/admin-api/analytics');
    expect(res.status).toBe(200);
    const { fraudByDevice } = res.body.data;
    expect(fraudByDevice).toHaveLength(10);
    expect(fraudByDevice[0]).toEqual({ deviceId: 'dev-A', count: 5, userCount: 2 });
    expect(fraudByDevice[1]).toEqual({ deviceId: 'dev-B', count: 5, userCount: 1 });
    expect(fraudByDevice.slice(2).map((d) => d.deviceId)).toEqual(['dev-C', 'dev-D', 'dev-E', 'dev-F', 'dev-G', 'dev-H', 'dev-I', 'dev-J']);
    expect(fraudByDevice.slice(2).every((d) => d.count === 1 && d.userCount === 1)).toBe(true);
    expect(fraudByDevice.some((d) => d.deviceId === 'dev-LOW')).toBe(false);
    expect(Object.keys(fraudByDevice[0]).sort()).toEqual(['count', 'deviceId', 'userCount']);
  });

  it('scoreHistogram: always 10 buckets 0-9 … 90-100, score 100 in the last bucket, ALL risk levels counted', async () => {
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    await bulk([0, 9, 10, 55, 89, 90, 99, 100, 100].map((fraudScore) => ({ userId: user._id, fraudScore })));
    const res = await agent.get('/admin-api/analytics');
    const { scoreHistogram } = res.body.data;
    expect(scoreHistogram).toHaveLength(10);
    expect(scoreHistogram.map((b) => b.label)).toEqual(['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100']);
    expect(scoreHistogram.map((b) => [b.from, b.to])).toEqual([[0, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]]);
    expect(scoreHistogram.map((b) => b.count)).toEqual([2, 1, 0, 0, 0, 1, 0, 0, 1, 4]);
    expect(Object.keys(scoreHistogram[0]).sort()).toEqual(['count', 'from', 'label', 'to']);
  });

  it('on an empty database both blocks are present: 10 zero buckets and []', async () => {
    const { agent } = await adminAgent();
    const { data } = (await agent.get('/admin-api/analytics')).body;
    expect(data.fraudByDevice).toEqual([]);
    expect(data.scoreHistogram).toHaveLength(10);
    expect(data.scoreHistogram.every((b) => b.count === 0)).toBe(true);
  });

  it('both honour startDate / endDate, and the existing keys are unchanged', async () => {
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    const noon = (day) => new Date(`2026-03-${day}T06:30:00.000Z`); // 12:00 IST
    await bulk([
      { userId: user._id, timestamp: noon('01'), fraudScore: 5, riskLevel: 'HIGH', deviceId: 'dev-old' },
      { userId: user._id, timestamp: noon('05'), fraudScore: 95, riskLevel: 'HIGH', deviceId: 'dev-new' },
      { userId: user._id, timestamp: noon('05'), fraudScore: 45, riskLevel: 'LOW', deviceId: 'dev-new' },
    ]);
    const res = await agent.get('/admin-api/analytics?startDate=2026-03-05&endDate=2026-03-05');
    const { data } = res.body;
    expect(data.fraudByDevice).toEqual([{ deviceId: 'dev-new', count: 1, userCount: 1 }]);
    expect(data.scoreHistogram.map((b) => b.count)).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(data.totalTransactions).toBe(2);
    expect(Object.keys(data)).toEqual(expect.arrayContaining([
      'totalTransactions', 'fraudRate', 'riskDistribution', 'fraudByHour', 'fraudByPaymentMethod', 'fraudByLocation',
      'lossPrevented', 'openCases', 'openAlerts', 'fraudByDevice', 'scoreHistogram',
    ]));
    expect(data.fraudByPaymentMethod).toHaveLength(1);
    expect(data.fraudByPaymentMethod[0].count).toBe(1);
    expect((await agent.get('/admin-api/analytics?startDate=banana')).status).toBe(400); // existing date validation untouched
  });
});

// ── A-02 timeline ───────────────────────────────────────────────────────────────────────────────────
describe('A-02 GET /customer-api/timeline', () => {
  const at = (hhmm) => new Date(`2026-03-09T${hhmm}:00.000Z`);
  const KEYS = ['amount', 'description', 'id', 'riskLevel', 'status', 'timestamp', 'title', 'transactionId', 'type'];

  async function seedTimeline() {
    const { user, agent } = await customer('tl');
    const other = await seedUser({ email: uniqueEmail('other') });
    const { user: analystUser } = await analyst('Detective Hidden');
    const t1 = await seedTransaction({ userId: user._id, amount: 1000, merchantName: 'Shop One', timestamp: at('10:00') });
    const t2 = await seedTransaction({ userId: user._id, amount: 2000, merchantName: 'Shop Two', timestamp: at('10:05'), riskLevel: 'MEDIUM', fraudScore: 30 });
    const t3 = await seedTransaction({ userId: user._id, amount: 70000, merchantName: 'Casino X', timestamp: at('10:10'), riskLevel: 'HIGH', fraudScore: 60, status: 'HELD' });
    const alert = await makeAlert(t3, { riskLevel: 'HIGH', fraudScore: 60, reasons: ['Transaction from unusual city: Dubai'], createdAt: at('10:11'), updatedAt: at('10:11') });
    const outcome = await NotificationModel.create({
      recipientId: user._id, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: 'Fraud Confirmed',
      message: `Our fraud team reviewed your transaction ${t3.publicId} and confirmed it as fraudulent.`,
      relatedEntityId: alert._id, relatedEntityType: 'FRAUD_ALERT', createdAt: at('10:20'), updatedAt: at('10:20'),
    });
    // NOT part of the feed: the plain alert notice, someone else's data, analyst-only data
    await NotificationModel.create({
      recipientId: user._id, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: 'HIGH Risk Transaction Detected',
      message: 'Your transaction was flagged.', relatedEntityId: alert._id, relatedEntityType: 'FRAUD_ALERT', createdAt: at('10:12'),
    });
    await FraudCaseModel.create({
      fraudAlertId: alert._id, transactionId: t3._id, assignedAnalystId: analystUser._id, status: 'RESOLVED',
      notes: [{ analystId: analystUser._id, text: 'SECRET-NOTE do not leak' }], resolutionSummary: 'SECRET-SUMMARY',
    });
    const otherTxn = await seedTransaction({ userId: other.user._id, merchantName: 'Strangers Shop', timestamp: at('11:00') });
    await makeAlert(otherTxn, { createdAt: at('11:01') });
    return { user, agent, t1, t2, t3, alert, outcome, analystUser, other };
  }

  it('merges transactions, alerts and case outcomes newest first with the documented shape', async () => {
    const { agent, t1, t2, t3, alert, outcome } = await seedTimeline();
    const res = await agent.get('/customer-api/timeline');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const events = res.body.data;
    expect(events.map((e) => e.type)).toEqual(['CASE_OUTCOME', 'ALERT', 'TRANSACTION', 'TRANSACTION', 'TRANSACTION']);
    expect(events.map((e) => e.timestamp)).toEqual([
      '2026-03-09T10:20:00.000Z', '2026-03-09T10:11:00.000Z', '2026-03-09T10:10:00.000Z', '2026-03-09T10:05:00.000Z', '2026-03-09T10:00:00.000Z',
    ]);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(KEYS);

    expect(events[0]).toMatchObject({
      id: `outcome-${outcome._id}`, type: 'CASE_OUTCOME', title: 'Fraud Confirmed', riskLevel: 'HIGH', status: 'RESOLVED',
      amount: 70000, transactionId: t3.publicId,
    });
    expect(events[0].description).toContain(t3.publicId);
    expect(events[1]).toMatchObject({
      id: `alert-${alert._id}`, type: 'ALERT', title: 'HIGH risk alert', description: 'Transaction from unusual city: Dubai',
      riskLevel: 'HIGH', status: 'OPEN', amount: 70000, transactionId: t3.publicId,
    });
    expect(events[2]).toMatchObject({
      id: `txn-${t3._id}`, type: 'TRANSACTION', title: 'Payment to Casino X', riskLevel: 'HIGH', status: 'HELD', amount: 70000, transactionId: t3.publicId,
    });
    expect(events[2].description).toBe('₹70,000 by UPI - held for review.');
    expect(events[3]).toMatchObject({ id: `txn-${t2._id}`, riskLevel: 'MEDIUM', status: 'APPROVED', amount: 2000, transactionId: t2.publicId });
    expect(events[4]).toMatchObject({ id: `txn-${t1._id}`, riskLevel: 'LOW', amount: 1000, transactionId: t1.publicId });
    expect(new Set(events.map((e) => e.id)).size).toBe(5);
  });

  it('shows only the caller\'s own data and never case notes, summaries or analyst identity', async () => {
    const { agent, analystUser, other } = await seedTimeline();
    const body = JSON.stringify((await agent.get('/customer-api/timeline')).body);
    expect(body).not.toMatch(/SECRET/);
    expect(body).not.toMatch(/Detective Hidden/);
    expect(body).not.toContain(String(analystUser._id));
    expect(body).not.toMatch(/Strangers Shop/);
    expect(body).not.toContain(String(other.user._id));
    expect(body).not.toMatch(/HIGH Risk Transaction Detected|was flagged\./); // the plain alert notice is not a case outcome
    const otherAgent = await loginAgent(other.user.email, other.password);
    const theirs = (await otherAgent.get('/customer-api/timeline')).body.data;
    expect(theirs.map((e) => e.type)).toEqual(['ALERT', 'TRANSACTION']);
  });

  it('DISMISSED outcomes read "DISMISSED"; limit cuts every source first and the merge afterwards', async () => {
    const { agent, user, alert } = await seedTimeline();
    await NotificationModel.create({
      recipientId: user._id, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: 'Flagged Transaction Cleared', message: 'No fraud found.',
      relatedEntityId: alert._id, relatedEntityType: 'FRAUD_ALERT', createdAt: at('10:30'),
    });
    const one = (await agent.get('/customer-api/timeline?limit=1')).body.data;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ type: 'CASE_OUTCOME', status: 'DISMISSED', title: 'Flagged Transaction Cleared' });
    const two = (await agent.get('/customer-api/timeline?limit=2')).body.data;
    expect(two.map((e) => e.status)).toEqual(['DISMISSED', 'RESOLVED']);
  });

  it('default limit 50, maximum 100', async () => {
    const { user, agent } = await customer('many');
    await bulk(Array.from({ length: 120 }, (_, i) => ({ userId: user._id, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })));
    expect((await agent.get('/customer-api/timeline')).body.data).toHaveLength(50);
    expect((await agent.get('/customer-api/timeline?limit=100')).body.data).toHaveLength(100);
    expect((await agent.get('/customer-api/timeline?limit=7')).body.data).toHaveLength(7);
    expect((await agent.get('/customer-api/timeline?limit=')).body.data).toHaveLength(50); // empty = default, like the other filters
    const newest = (await agent.get('/customer-api/timeline?limit=1')).body.data[0];
    expect(newest.timestamp).toBe('2026-01-01T00:01:59.000Z');
  });

  it('answers an empty list for a customer without activity', async () => {
    const { agent } = await customer('none');
    const res = await agent.get('/customer-api/timeline');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  it.each(['0', '101', '-1', 'abc', '1.5', '1e2', '5x'])('rejects limit=%s with 422', async (limit) => {
    const { agent } = await customer('lim');
    const res = await agent.get(`/customer-api/timeline?limit=${limit}`);
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].path).toBe('limit');
  });

  it('rejects a repeated limit (422) and is customer-only (401 / 403)', async () => {
    const { agent } = await customer('arr');
    expect((await agent.get('/customer-api/timeline?limit=5&limit=6')).status).toBe(422);
    expect((await createAgent().get('/customer-api/timeline')).status).toBe(401);
    expect((await (await analyst()).agent.get('/customer-api/timeline')).status).toBe(403);
    expect((await (await adminAgent()).agent.get('/customer-api/timeline')).status).toBe(403);
  });
});

// ── A-04 forecast ───────────────────────────────────────────────────────────────────────────────────
describe('A-04 GET /admin-api/analytics/trends forecast', () => {
  /** HIGH transactions at 12:00 IST, `daysBack` days before the frozen "today" (2026-03-10 IST). */
  const onDay = (daysBack, count, userId, extra = {}) =>
    Array.from({ length: count }, () => ({ userId, riskLevel: 'HIGH', fraudScore: 60, amount: 100, status: 'HELD', recommendedAction: 'HOLD', timestamp: new Date(Date.UTC(2026, 2, 10 - daysBack, 6, 30)), ...extra }));

  it('predicts the next 7 IST days by least squares on the last 14 days (exact on a straight line)', async () => {
    freezeClock();
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    // oldest of the 14 days has 1 payment, today has 14 → count = day index + 1
    await bulk(Array.from({ length: 14 }, (_, k) => onDay(13 - k, k + 1, user._id)).flat());
    const res = await agent.get('/admin-api/analytics/trends');
    expect(res.status).toBe(200);
    const { forecast, dailyTrend, peakFraudHours } = res.body.data;
    expect(dailyTrend).toHaveLength(31);   // existing response untouched
    expect(Array.isArray(peakFraudHours)).toBe(true);
    expect(forecast.available).toBe(true);
    expect(forecast.method).toBe('linear-regression-14d');
    expect(forecast.days.map((d) => d.date)).toEqual(['2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16', '2026-03-17']);
    expect(forecast.days.map((d) => d.count)).toEqual([15, 16, 17, 18, 19, 20, 21]);
    expect(forecast.days.map((d) => d.totalAmount)).toEqual([1500, 1600, 1700, 1800, 1900, 2000, 2100]);
    expect(forecast.days.every((d) => d.avgFraudScore === 60)).toBe(true);
    for (const d of forecast.days) {
      expect(Object.keys(d)).toEqual(['date', 'count', 'totalAmount', 'avgFraudScore', 'movingAvg']);
      expect(Number.isInteger(d.count)).toBe(true);
      expect(d.movingAvg).toBeGreaterThan(0);
      expect(Math.round(d.movingAvg * 100) / 100).toBe(d.movingAvg);
    }
    // every series of the existing trend rows is forecast under the same name
    expect(Object.keys(dailyTrend[0]).filter((k) => k !== 'date')).toEqual(Object.keys(forecast.days[0]).filter((k) => k !== 'date'));
  });

  it('a falling series is clamped at 0 (never negative)', async () => {
    freezeClock();
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    await bulk(Array.from({ length: 14 }, (_, k) => onDay(13 - k, 14 - k, user._id)).flat());
    const { forecast } = (await agent.get('/admin-api/analytics/trends')).body.data;
    expect(forecast.available).toBe(true);
    expect(forecast.days.map((d) => d.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(forecast.days.every((d) => d.totalAmount === 0 && d.movingAvg >= 0)).toBe(true);
  });

  it('money is rounded to 2 decimals, counts to integers', async () => {
    freezeClock();
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    await bulk(Array.from({ length: 14 }, (_, k) => onDay(13 - k, 1 + (k % 3), user._id, { amount: 33.33 })).flat());
    const { forecast } = (await agent.get('/admin-api/analytics/trends')).body.data;
    for (const d of forecast.days) {
      expect(Number.isInteger(d.count)).toBe(true);
      expect(Math.round(d.totalAmount * 100) / 100).toBe(d.totalAmount);
    }
  });

  it('fewer than 7 days with data → available:false and days:[]', async () => {
    freezeClock();
    const { agent } = await adminAgent();
    const { user } = await seedUser();
    await bulk([0, 1, 2, 3, 4, 5].flatMap((back) => onDay(back, 2, user._id))); // 6 days
    const { forecast } = (await agent.get('/admin-api/analytics/trends')).body.data;
    expect(forecast).toEqual({ available: false, method: 'linear-regression-14d', days: [] });
    await bulk(onDay(6, 1, user._id)); // the 7th day with data
    expect((await agent.get('/admin-api/analytics/trends')).body.data.forecast.available).toBe(true);
  });

  it('an empty database is unavailable, not an error', async () => {
    const { agent } = await adminAgent();
    const res = await agent.get('/admin-api/analytics/trends');
    expect(res.status).toBe(200);
    expect(res.body.data.forecast).toEqual({ available: false, method: 'linear-regression-14d', days: [] });
  });
});

// ── B-07 threshold preview ──────────────────────────────────────────────────────────────────────────
describe('B-07 POST /admin-api/thresholds/preview', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const SCORES = [10, 20, 25, 29, 30, 49, 50, 74, 75, 79, 80, 100];

  async function seedScores() {
    const { user } = await seedUser();
    await bulk([
      ...SCORES.map((fraudScore, i) => ({ userId: user._id, fraudScore, timestamp: new Date(Date.now() - (i + 1) * DAY) })),
      { userId: user._id, fraudScore: 99, timestamp: new Date(Date.now() - 40 * DAY) }, // outside the 30-day window
    ]);
  }

  it('re-bands the last 30 days of stored scores: exact counts for current and proposed bands, and moved', async () => {
    await seedScores();
    const { agent } = await adminAgent();
    const res = await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30, criticalMin: 80 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        windowDays: 30,
        total: 12,
        current: { LOW: 2, MEDIUM: 4, HIGH: 2, CRITICAL: 4 },
        proposed: { LOW: 4, MEDIUM: 2, HIGH: 4, CRITICAL: 2 },
        moved: { up: 0, down: 4, unchanged: 8 },
        note: 'Re-bands stored fraud scores; rule weights and velocity limits are not re-evaluated.',
      },
    });
  });

  it('lowering a band moves scores UP; unchanged bands report everything unchanged', async () => {
    await seedScores();
    const { agent } = await adminAgent();
    const lower = (await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 10 } })).body.data;
    expect(lower.current).toEqual({ LOW: 2, MEDIUM: 4, HIGH: 2, CRITICAL: 4 });
    expect(lower.proposed).toEqual({ LOW: 0, MEDIUM: 6, HIGH: 2, CRITICAL: 4 }); // 10 and 20 are MEDIUM now
    expect(lower.moved).toEqual({ up: 2, down: 0, unchanged: 10 });
    const same = (await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 } })).body.data;
    expect(same.moved).toEqual({ up: 0, down: 0, unchanged: 12 });
    expect(same.proposed).toEqual(same.current);
  });

  it('uses the STORED bands as "current" (defaults when nothing is stored)', async () => {
    await seedScores();
    const { agent } = await adminAgent();
    await seedConfig({ scoreThresholds: { mediumMin: 20, highMin: 60, criticalMin: 90 } });
    const stored = (await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { criticalMin: 95 } })).body.data;
    // 10 | 20,25,29,30,49,50 | 74,75,79,80 | 100 → proposed critical 95 keeps only 100 CRITICAL
    expect(stored.current).toEqual({ LOW: 1, MEDIUM: 6, HIGH: 4, CRITICAL: 1 });
    expect(stored.proposed).toEqual(stored.current);
    await SystemConfigModel.deleteMany({});
    const fallback = (await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30 } })).body.data;
    expect(fallback.current).toEqual({ LOW: 2, MEDIUM: 4, HIGH: 2, CRITICAL: 4 }); // built-in 25 / 50 / 75
  });

  it('writes NOTHING: no config change, no audit entry, no other document', async () => {
    await seedScores();
    const { agent } = await adminAgent();
    const before = (await SystemConfigModel.findOne({ singleton: 'system' }).lean());
    const audits = await AuditLogModel.countDocuments({});
    const txns = await TransactionModel.countDocuments({});
    expect((await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 40 } })).status).toBe(200);
    const after = (await SystemConfigModel.findOne({ singleton: 'system' }).lean());
    expect(after).toEqual(before);
    expect(after.scoreThresholds.mediumMin).toBe(25);
    expect(await AuditLogModel.countDocuments({})).toBe(audits);
    expect(await TransactionModel.countDocuments({})).toBe(txns);
  });

  it('uses the PATCH validators: 422 for invalid values and for a merged ordering violation', async () => {
    const { agent } = await adminAgent();
    const bad = async (body) => (await agent.post('/admin-api/thresholds/preview').send(body));
    expect((await bad({ scoreThresholds: { mediumMin: 'abc' } })).status).toBe(422);
    expect((await bad({ scoreThresholds: { mediumMin: 0 } })).status).toBe(422);
    expect((await bad({ scoreThresholds: { criticalMin: 101 } })).status).toBe(422);
    expect((await bad({ scoreThresholds: 'x' })).status).toBe(422);
    expect((await bad({ scoreThresholds: { mediumMin: 40, highMin: 30, criticalMin: 80 } })).status).toBe(422);
    const merged = await bad({ scoreThresholds: { mediumMin: 60 } }); // stored highMin is 50
    expect(merged.status).toBe(422);
    expect(merged.body.message).toMatch(/ordering violated after merge/);
    expect(merged.body.errors).toEqual([{ msg: merged.body.message }]);
    const velocity = await bad({ scoreThresholds: { mediumMin: 30 }, velocityLimit: { maxPerHour: 50 } }); // stored maxPerDay is 20
    expect(velocity.status).toBe(422);
    expect(velocity.body.message).toMatch(/maxPerDay/);
  });

  it('a body without scoreThresholds is a 400; non-admins are refused', async () => {
    const { agent } = await adminAgent();
    expect((await agent.post('/admin-api/thresholds/preview').send({})).status).toBe(400);
    expect((await agent.post('/admin-api/thresholds/preview').send({ amountThreshold: 10 })).status).toBe(400);
    expect((await createAgent().post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30 } })).status).toBe(401);
    expect((await (await customer()).agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30 } })).status).toBe(403);
    expect((await (await analyst()).agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30 } })).status).toBe(403);
  });

  it('an empty window reports zeros', async () => {
    const { agent } = await adminAgent();
    const { data } = (await agent.post('/admin-api/thresholds/preview').send({ scoreThresholds: { mediumMin: 30 } })).body;
    expect(data.total).toBe(0);
    expect(data.current).toEqual({ LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 });
    expect(data.moved).toEqual({ up: 0, down: 0, unchanged: 0 });
  });
});

// ── F-02 acknowledge ────────────────────────────────────────────────────────────────────────────────
describe('F-02 PATCH /customer-api/fraud-alerts/:id/acknowledge', () => {
  async function mediumAlert(user, o = {}) {
    const t = await seedTransaction({ userId: user._id, riskLevel: 'MEDIUM', fraudScore: 30, ...o.txn });
    return { t, alert: await makeAlert(t, o.alert) };
  }

  it('OPEN MEDIUM alert → ACKNOWLEDGED, same shape as GET /fraud-alerts/:id, audited', async () => {
    const { user, agent } = await customer();
    const { t, alert } = await mediumAlert(user);
    const res = await agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ACKNOWLEDGED');
    expect(res.body.data._id).toBe(String(alert._id));
    expect(res.body.data.transactionId.publicId).toBe(t.publicId); // populated, like GET /:id
    const detail = (await agent.get(`/customer-api/fraud-alerts/${alert._id}`)).body.data;
    expect(Object.keys(res.body.data).sort()).toEqual(Object.keys(detail).sort());
    expect((await FraudAlertModel.findById(alert._id)).status).toBe('ACKNOWLEDGED');

    const audit = await AuditLogModel.findOne({ action: 'ALERT_ACKNOWLEDGED' });
    expect(audit).toMatchObject({ actorRole: 'CUSTOMER', entityType: 'FraudAlert', entityId: String(alert._id) });
    expect(String(audit.actorId)).toBe(String(user._id));
    expect(audit.metadata).toMatchObject({ transactionId: t.publicId, riskLevel: 'MEDIUM', previousStatus: 'OPEN' });
  });

  it('is not repeatable: a second acknowledge, and any non-OPEN status, is a 400', async () => {
    const { user, agent } = await customer();
    const { alert } = await mediumAlert(user);
    expect((await agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`)).status).toBe(200);
    const again = await agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already acknowledged/);
    for (const status of ['REVIEWED', 'DISMISSED']) {
      const { alert: other } = await mediumAlert(user, { alert: { status } });
      const res = await agent.patch(`/customer-api/fraud-alerts/${other._id}/acknowledge`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(new RegExp(`already ${status.toLowerCase()}`));
    }
    expect(await AuditLogModel.countDocuments({ action: 'ALERT_ACKNOWLEDGED' })).toBe(1);
  });

  it('HIGH and CRITICAL alerts cannot be acknowledged (400, unchanged)', async () => {
    const { user, agent } = await customer();
    for (const riskLevel of ['HIGH', 'CRITICAL']) {
      const { alert } = await mediumAlert(user, { alert: { riskLevel, fraudScore: 80 }, txn: { riskLevel } });
      const res = await agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Only MEDIUM/);
      expect((await FraudAlertModel.findById(alert._id)).status).toBe('OPEN');
    }
  });

  it('only the owner: another customer gets 404, unknown id 404, malformed id 400', async () => {
    const owner = await customer('own');
    const intruder = await customer('int');
    const { alert } = await mediumAlert(owner.user);
    expect((await intruder.agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`)).status).toBe(404);
    expect((await owner.agent.patch(`/customer-api/fraud-alerts/${new mongoose.Types.ObjectId()}/acknowledge`)).status).toBe(404);
    expect((await owner.agent.patch('/customer-api/fraud-alerts/not-an-id/acknowledge')).status).toBe(400);
    expect((await FraudAlertModel.findById(alert._id)).status).toBe('OPEN');
  });

  it('roles: analyst and admin 403, anonymous 401', async () => {
    const { user } = await customer();
    const { alert } = await mediumAlert(user);
    const url = `/customer-api/fraud-alerts/${alert._id}/acknowledge`;
    expect((await createAgent().patch(url)).status).toBe(401);
    expect((await (await analyst()).agent.patch(url)).status).toBe(403);
    expect((await (await adminAgent()).agent.patch(url)).status).toBe(403);
  });

  it('ACKNOWLEDGED is a valid status filter and is never counted as open', async () => {
    const { user, agent } = await customer();
    const { alert } = await mediumAlert(user);
    const stillOpen = await mediumAlert(user);
    await agent.patch(`/customer-api/fraud-alerts/${alert._id}/acknowledge`);

    const ack = await agent.get('/customer-api/fraud-alerts?status=ACKNOWLEDGED');
    expect(ack.status).toBe(200);
    expect(ack.body.data.map((a) => a._id)).toEqual([String(alert._id)]);
    const open = await agent.get('/customer-api/fraud-alerts?status=OPEN');
    expect(open.body.data.map((a) => a._id)).toEqual([String(stillOpen.alert._id)]);
    expect((await agent.get('/customer-api/fraud-alerts?status=GARBAGE')).status).toBe(422);

    // admin dashboard: only OPEN HIGH/CRITICAL alerts need an analyst; an acknowledged MEDIUM one never does
    const { agent: adm } = await adminAgent();
    const t = await seedTransaction({ userId: user._id, riskLevel: 'HIGH', status: 'HELD' });
    await makeAlert(t, { riskLevel: 'HIGH', fraudScore: 60 });
    expect((await adm.get('/admin-api/analytics')).body.data.openAlerts).toBe(1);
  });

  it('the model accepts the new status and rejects unknown ones', async () => {
    const { user } = await customer();
    const { alert } = await mediumAlert(user);
    alert.status = 'ACKNOWLEDGED';
    await expect(alert.validate()).resolves.toBeUndefined();
    alert.status = 'WHATEVER';
    await expect(alert.validate()).rejects.toThrow(/OPEN, REVIEWED, DISMISSED, or ACKNOWLEDGED/);
  });
});

// ── A-08 simulation generator ───────────────────────────────────────────────────────────────────────
describe('A-08 simulation generate / clear', () => {
  const generate = (agent, body = {}) => agent.post('/admin-api/simulation/generate').send(body);
  const simUsers = () => UserModel.find({ isSimulated: true }).sort({ email: 1 });

  it('is ADMIN-only on both routes (401 / 403)', async () => {
    for (const [method, url] of [['post', '/admin-api/simulation/generate'], ['delete', '/admin-api/simulation/data']]) {
      expect((await createAgent()[method](url).send({})).status).toBe(401);
      expect((await (await customer()).agent[method](url).send({})).status).toBe(403);
      expect((await (await analyst()).agent[method](url).send({})).status).toBe(403);
    }
    expect(await UserModel.countDocuments({ isSimulated: true })).toBe(0);
  });

  it('validates count (1..100) with 422', async () => {
    const { agent } = await adminAgent();
    for (const count of [0, 101, -3, 'abc', 1.5, null]) {
      expect((await generate(agent, { count })).status).toBe(422);
    }
    expect(await TransactionModel.countDocuments({ isSimulated: true })).toBe(0);
  });

  it('default 30 payments go through the REAL pipeline: all four risk bands, alerts, notifications, audit', async () => {
    const { agent, user: adm } = await adminAgent();
    const res = await generate(agent);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { data } = res.body;
    expect(Object.keys(data).sort()).toEqual(['byRiskLevel', 'byStatus', 'generated', 'simulatedTransactionsTotal']);
    expect(data.generated).toBe(30);
    expect(data.simulatedTransactionsTotal).toBe(30);
    expect(Object.keys(data.byRiskLevel)).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    expect(Object.keys(data.byStatus)).toEqual(['APPROVED', 'HELD', 'BLOCKED']);
    expect(Object.values(data.byRiskLevel).reduce((s, n) => s + n, 0)).toBe(30);
    expect(Object.values(data.byStatus).reduce((s, n) => s + n, 0)).toBe(30);
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) expect(data.byRiskLevel[level]).toBeGreaterThan(0); // every band appears
    expect(data.byStatus.HELD).toBe(data.byRiskLevel.HIGH);
    expect(data.byStatus.BLOCKED).toBe(data.byRiskLevel.CRITICAL);

    // the synthetic customers
    const users = await simUsers();
    expect(users.map((u) => u.email)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `sim.customer.${n}@simulation.finguard.local`));
    expect(users.map((u) => u.name)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Sim Customer ${n}`));
    expect(users.every((u) => u.role === 'CUSTOMER' && u.isSimulated === true && u.isActive)).toBe(true);
    const withHash = await UserModel.findById(users[0]._id).select('+password');
    expect(withHash.password).toMatch(/^\$2[aby]\$12\$/);

    // the transactions: all marked, all on sim- devices, real alerts / notifications / audit entries
    const txns = await TransactionModel.find({}).lean();
    expect(txns).toHaveLength(30);
    expect(txns.every((t) => t.isSimulated === true && t.deviceId.startsWith('sim-'))).toBe(true);
    expect(txns.every((t) => users.some((u) => String(u._id) === String(t.userId)))).toBe(true);
    expect(txns.every((t) => t.scoreBreakdown.length === 6 && /^TXN-\d{4}-\d{5}$/.test(t.publicId))).toBe(true);
    const flagged = txns.filter((t) => t.riskLevel !== 'LOW').length;
    expect(await FraudAlertModel.countDocuments({})).toBe(flagged);
    expect(await NotificationModel.countDocuments({ recipientRole: 'CUSTOMER' })).toBe(flagged);
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_SUBMITTED' })).toBe(30);
    expect(await DeviceReputationModel.countDocuments({ deviceId: { $not: /^sim-/ } })).toBe(0);
    expect(await BehaviorProfileModel.countDocuments({})).toBeGreaterThan(0);

    const audit = await AuditLogModel.findOne({ action: 'SIMULATION_DATA_GENERATED' });
    expect(audit).toMatchObject({ actorRole: 'ADMIN', entityType: 'SystemConfig', entityId: 'simulation' });
    expect(String(audit.actorId)).toBe(String(adm._id));
    expect(audit.metadata).toMatchObject({ requested: 30, generated: 30, simulatedTransactionsTotal: 30 });
  }, 90_000);

  it('count controls the size; users are reused on the next call; the running total accumulates', async () => {
    const { agent } = await adminAgent();
    const first = (await generate(agent, { count: 10 })).body.data;
    expect(first.generated).toBe(10);
    expect(await UserModel.countDocuments({ isSimulated: true })).toBe(2); // ceil(10 / 5) customers
    const ids = (await simUsers()).map((u) => String(u._id));
    const second = (await generate(agent, { count: 5 })).body.data;
    expect(second.simulatedTransactionsTotal).toBe(15);
    expect((await simUsers()).map((u) => String(u._id))).toEqual(expect.arrayContaining(ids));
    expect(await UserModel.countDocuments({ isSimulated: true })).toBe(2);
    expect(await TransactionModel.countDocuments({ isSimulated: true })).toBe(15);
    expect((await generate(agent, { count: 1 })).body.data.generated).toBe(1);
  }, 60_000);

  it('refuses to exceed 500 simulated transactions in total (400) and still allows exactly 500', async () => {
    const { agent } = await adminAgent();
    const { user } = await seedUser({ email: 'sim.customer.1@simulation.finguard.local', isSimulated: true });
    await bulk(Array.from({ length: 480 }, () => ({ userId: user._id, deviceId: 'sim-u1-home', isSimulated: true })));
    const tooMany = await generate(agent, { count: 21 });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.success).toBe(false);
    expect(tooMany.body.message).toMatch(/480 simulated transactions already exist and at most 500/);
    expect(await TransactionModel.countDocuments({ isSimulated: true })).toBe(480);
    const exact = await generate(agent, { count: 20 });
    expect(exact.status).toBe(200);
    expect(exact.body.data.simulatedTransactionsTotal).toBe(500);
    const over = await generate(agent, { count: 1 });
    expect(over.status).toBe(400);
    expect(await TransactionModel.countDocuments({ isSimulated: true })).toBe(500);
  }, 60_000);

  it('rate limit: 10 requests per hour per admin, then 429 (another admin is unaffected)', async () => {
    const { agent } = await adminAgent();
    for (let i = 0; i < 10; i += 1) expect((await generate(agent, { count: 1 })).status).toBe(200);
    const blocked = await generate(agent, { count: 1 });
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.message).toMatch(/rate limit/i);
    expect((await generate((await adminAgent()).agent, { count: 1 })).status).toBe(200);
    // invalid bodies do not consume the quota
    const fresh = (await adminAgent()).agent;
    for (let i = 0; i < 12; i += 1) expect((await generate(fresh, { count: 0 })).status).toBe(422);
    expect((await generate(fresh, { count: 1 })).status).toBe(200);
  }, 90_000);

  it('never touches a real account that holds a reserved address (409)', async () => {
    const { agent } = await adminAgent();
    const { user } = await seedUser({ email: 'sim.customer.1@simulation.finguard.local' });
    const res = await generate(agent, { count: 5 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/real account/);
    expect((await UserModel.findById(user._id)).isSimulated).toBe(false);
    expect(await TransactionModel.countDocuments({})).toBe(0);
  });

  it('a customer cannot mark their own data as simulated, and sim customers cannot log in', async () => {
    const { agent, user } = await customer('mark');
    const posted = await agent.post('/customer-api/transactions').send({ ...txn(), isSimulated: true });
    expect(posted.status).toBe(201);
    expect((await TransactionModel.findById(posted.body.data.id).lean()).isSimulated).toBeUndefined();
    const reg = await createAgent().post('/auth/register').send({ name: 'Sneaky', email: 'sneaky@test.com', password: 'Password@123', role: 'CUSTOMER', isSimulated: true });
    expect(reg.status).toBe(201);
    expect((await UserModel.findOne({ email: 'sneaky@test.com' })).isSimulated).toBe(false);
    expect((await UserModel.findById(user._id)).isSimulated).toBe(false);

    const { agent: adm } = await adminAgent();
    await generate(adm, { count: 1 });
    const login = await createAgent().post('/auth/login').send({ email: 'sim.customer.1@simulation.finguard.local', password: 'Password@123' });
    expect(login.status).toBe(401);
  }, 60_000);

  it('simulated users show up in user management with the flag', async () => {
    const { agent } = await adminAgent();
    await generate(agent, { count: 5 });
    const list = (await agent.get('/admin-api/users?role=CUSTOMER')).body.data;
    const sims = list.filter((u) => u.isSimulated === true);
    expect(sims).toHaveLength(1);
    expect(sims[0].email).toBe('sim.customer.1@simulation.finguard.local');
    expect(sims[0].password).toBeUndefined();
  });

  it('DELETE removes every simulated document and nothing real (audit rows stay)', async () => {
    // ── real data first: a customer with a clean and a flagged payment, an analyst case, devices
    const real = await customer('real');
    await real.agent.post('/customer-api/transactions').send(txn({ deviceId: 'real-dev' }));
    const flaggedRes = await real.agent.post('/customer-api/transactions').send(highRisk);
    const an = await analyst();
    const realCase = (await an.agent.post('/analyst-api/cases').send({ fraudAlertId: flaggedRes.body.data.fraudAlert.id })).body.data;
    const realCaseNotification = await NotificationModel.create({
      recipientId: an.user._id, recipientRole: 'ANALYST', type: 'CASE_ASSIGNED', title: 'Case', message: 'Real case',
      relatedEntityId: realCase._id, relatedEntityType: 'FRAUD_CASE',
    });
    // a real customer may type ANY device id: one that merely looks simulated, and one a sim user shares later
    await DeviceReputationModel.create({ deviceId: 'sim-looks-real', associatedUserIds: [real.user._id] });
    await DeviceReputationModel.create({ deviceId: 'sim-shared', associatedUserIds: [real.user._id] });
    await bulk([{ userId: real.user._id, deviceId: 'sim-shared' }]);
    const { agent: adm } = await adminAgent();

    const collections = { User: UserModel, Transaction: TransactionModel, FraudAlert: FraudAlertModel, FraudCase: FraudCaseModel, Notification: NotificationModel, DeviceReputation: DeviceReputationModel, BehaviorProfile: BehaviorProfileModel };
    const counts = async () => Object.fromEntries(await Promise.all(Object.entries(collections).map(async ([k, m]) => [k, await m.countDocuments({})])));
    const realSnapshot = await counts();
    const realDocs = {
      users: (await UserModel.find({}).lean()).map((u) => String(u._id)).sort(),
      txns: (await TransactionModel.find({}).lean()).map((t) => String(t._id)).sort(),
    };

    // ── generate, then add the analyst-side and shared-device traces of the synthetic data
    expect((await generate(adm, { count: 30 })).status).toBe(200);
    const simIds = (await simUsers()).map((u) => u._id);
    const simAlert = await FraudAlertModel.findOne({ userId: { $in: simIds }, riskLevel: { $in: ['HIGH', 'CRITICAL'] } });
    expect(simAlert).not.toBeNull();
    const simCase = (await an.agent.post('/analyst-api/cases').send({ fraudAlertId: simAlert._id })).body.data;
    expect((await an.agent.post(`/analyst-api/cases/${simCase._id}/notes`).send({ text: 'sim note' })).status).toBe(201);
    await NotificationModel.create({
      recipientId: an.user._id, recipientRole: 'ANALYST', type: 'CASE_ASSIGNED', title: 'Case', message: 'Sim case',
      relatedEntityId: simCase._id, relatedEntityType: 'FRAUD_CASE',
    });
    await DeviceReputationModel.updateOne({ deviceId: 'sim-shared' }, { $addToSet: { associatedUserIds: simIds[0] } });

    const expected = {
      users: await UserModel.countDocuments({ isSimulated: true }),
      transactions: await TransactionModel.countDocuments({ userId: { $in: simIds } }),
      fraudAlerts: await FraudAlertModel.countDocuments({ userId: { $in: simIds } }),
      cases: 1,
      notifications: await NotificationModel.countDocuments({ $or: [{ recipientId: { $in: simIds } }, { relatedEntityId: simCase._id }] }),
      deviceReputations: await DeviceReputationModel.countDocuments({ deviceId: /^sim-u/ }),
      behaviorProfiles: await BehaviorProfileModel.countDocuments({ userId: { $in: simIds } }),
    };
    expect(expected.users).toBe(6);
    expect(expected.transactions).toBe(30);
    expect(expected.fraudAlerts).toBeGreaterThan(0);
    expect(expected.notifications).toBeGreaterThan(expected.fraudAlerts); // + the analyst's notice about the sim case
    expect(expected.deviceReputations).toBeGreaterThan(0);
    expect(expected.behaviorProfiles).toBeGreaterThan(0);
    const auditBefore = await AuditLogModel.countDocuments({});

    // ── clear
    const res = await adm.delete('/admin-api/simulation/data');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(expected);

    // everything synthetic is gone ...
    expect(await UserModel.countDocuments({ isSimulated: true })).toBe(0);
    expect(await TransactionModel.countDocuments({ isSimulated: true })).toBe(0);
    expect(await FraudAlertModel.countDocuments({ userId: { $in: simIds } })).toBe(0);
    expect(await FraudCaseModel.countDocuments({ _id: simCase._id })).toBe(0);
    expect(await NotificationModel.countDocuments({ $or: [{ recipientId: { $in: simIds } }, { relatedEntityId: simCase._id }] })).toBe(0);
    expect(await DeviceReputationModel.countDocuments({ deviceId: /^sim-u/ })).toBe(0);
    expect(await BehaviorProfileModel.countDocuments({ userId: { $in: simIds } })).toBe(0);

    // ... and every real document is still there (same counts, same ids)
    expect(await counts()).toEqual(realSnapshot);
    expect((await UserModel.find({}).lean()).map((u) => String(u._id)).sort()).toEqual(realDocs.users);
    expect((await TransactionModel.find({}).lean()).map((t) => String(t._id)).sort()).toEqual(realDocs.txns);
    expect(await FraudCaseModel.countDocuments({ _id: realCase._id })).toBe(1);
    expect(await NotificationModel.countDocuments({ _id: realCaseNotification._id })).toBe(1);
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'real-dev' })).toBe(1);
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'sim-looks-real' })).toBe(1);
    const shared = await DeviceReputationModel.findOne({ deviceId: 'sim-shared' });
    expect(shared.associatedUserIds.map(String)).toEqual([String(real.user._id)]); // the synthetic user was taken out of it

    // the audit trail is immutable: nothing deleted, one entry added
    expect(await AuditLogModel.countDocuments({})).toBe(auditBefore + 1);
    const audit = await AuditLogModel.findOne({ action: 'SIMULATION_DATA_CLEARED' });
    expect(audit.metadata).toMatchObject(expected);
    expect(await AuditLogModel.countDocuments({ action: 'TRANSACTION_SUBMITTED', entityType: 'Transaction' })).toBeGreaterThanOrEqual(32);

    // clearing twice is harmless and the generator works again afterwards
    const again = await adm.delete('/admin-api/simulation/data');
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ users: 0, transactions: 0, fraudAlerts: 0, cases: 0, notifications: 0, deviceReputations: 0, behaviorProfiles: 0 });
    expect((await generate(adm, { count: 5 })).body.data.simulatedTransactionsTotal).toBe(5);
  }, 180_000);

  it('with no simulated data DELETE removes nothing at all', async () => {
    const real = await customer('safe');
    await real.agent.post('/customer-api/transactions').send(txn());
    const { agent } = await adminAgent();
    const before = [await UserModel.countDocuments({}), await TransactionModel.countDocuments({}), await BehaviorProfileModel.countDocuments({}), await DeviceReputationModel.countDocuments({})];
    const res = await agent.delete('/admin-api/simulation/data');
    expect(res.body.data).toEqual({ users: 0, transactions: 0, fraudAlerts: 0, cases: 0, notifications: 0, deviceReputations: 0, behaviorProfiles: 0 });
    expect([await UserModel.countDocuments({}), await TransactionModel.countDocuments({}), await BehaviorProfileModel.countDocuments({}), await DeviceReputationModel.countDocuments({})]).toEqual(before);
  });

  it('the existing start / stop endpoints are unchanged', async () => {
    const { agent } = await adminAgent();
    const start = await agent.post('/admin-api/simulation/start').send({ transactionCount: 5 });
    expect(start.status).toBe(200);
    expect(start.body.data).toEqual({ transactionCount: 5 });
    expect((await agent.post('/admin-api/simulation/stop')).status).toBe(200);
  });
});

// ── D-02 / R-01 login throttle ──────────────────────────────────────────────────────────────────────
describe('D-02 / R-01 login throttle', () => {
  // a fresh client address per test: the per-IP limiter (10 failures / 15 min) is process memory and is not reset between tests
  let testIp = 0;
  let currentIp;
  beforeEach(() => { testIp += 1; currentIp = `198.18.0.${testIp}`; });
  const login = (email, password, ip) => createAgent(ip ?? currentIp).post('/auth/login').send({ email, password });

  it('5 failures from one IP lock that e-mail+IP: 429 + Retry-After, even with the right password; it recovers after 15 minutes', async () => {
    freezeClock();
    const { user, password } = await seedUser({ email: uniqueEmail('lock') });
    for (let i = 0; i < 5; i += 1) expect((await login(user.email, 'Wrong@999')).status).toBe(401);

    const blocked = await login(user.email, password);
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.message).toMatch(/Too many failed sign-in attempts/);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.headers['set-cookie']).toBeUndefined();

    jest.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
    const later = await login(user.email.toUpperCase(), 'Wrong@999'); // case-insensitive key
    expect(later.status).toBe(429);
    expect(later.headers['retry-after']).toBe('600');

    jest.setSystemTime(new Date(Date.now() + 10 * 60 * 1000 + 1000));
    expect((await login(user.email, password)).status).toBe(200);
  });

  it('R-01: an attacker\'s lock does not lock the owner out from another IP', async () => {
    const { user, password } = await seedUser({ email: uniqueEmail('victim') });
    for (let i = 0; i < 5; i += 1) await login(user.email, 'Wrong@999', '203.0.113.66'); // the attacker's address
    expect((await login(user.email, 'Wrong@999', '203.0.113.66')).status).toBe(429);
    const owner = await login(user.email, password, '198.51.100.7');
    expect(owner.status).toBe(200);
  });

  it('R-01: 30 attempts spread over many IPs lock the e-mail for everyone (generic 429)', async () => {
    const { user, password } = await seedUser({ email: uniqueEmail('spread') });
    // 30 distinct client addresses × 1 wrong password each (below every per-IP limit)
    const statuses = [];
    for (let i = 0; i < 30; i += 1) statuses.push((await login(user.email, 'Wrong@999', `192.0.2.${i + 1}`)).status);
    expect(statuses.every((st) => st === 401)).toBe(true);
    const owner = await login(user.email, password, '198.51.100.8');
    expect(owner.status).toBe(429);
    expect(owner.headers['retry-after']).toBeDefined();
  }, 60_000);

  it('R-01: a parallel burst cannot all pass the check — exactly 5 reach the password comparison', async () => {
    const { user } = await seedUser({ email: uniqueEmail('burst') });
    const results = await Promise.all(Array.from({ length: 12 }, () => login(user.email, 'Wrong@999', '203.0.113.20')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((st) => st === 401)).toHaveLength(5);
    expect(statuses.filter((st) => st === 429)).toHaveLength(7);
    expect(await AuditLogModel.countDocuments({ action: 'LOGIN_FAILED' })).toBe(5);
  }, 60_000);

  it('wording and status are identical for existing and unknown e-mails (no account probing)', async () => {
    freezeClock();
    const { user } = await seedUser({ email: uniqueEmail('real') });
    const ghost = 'nobody-here@test.com';
    for (let i = 0; i < 5; i += 1) {
      expect((await login(user.email, 'Wrong@999', '203.0.113.31')).status).toBe(401);
      expect((await login(ghost, 'Wrong@999', '203.0.113.32')).status).toBe(401); // unknown e-mails are counted the same way
    }
    const a = await login(user.email, 'Wrong@999', '203.0.113.31');
    const b = await login(ghost, 'Wrong@999', '203.0.113.32');
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(a.body).toEqual(b.body);
    expect(a.headers['retry-after']).toBe(b.headers['retry-after']);
  });

  it('a successful login clears the counters; other e-mails are unaffected', async () => {
    const { user, password } = await seedUser({ email: uniqueEmail('clear') });
    const { user: bystander, password: bystanderPassword } = await seedUser({ email: uniqueEmail('by') });
    for (let i = 0; i < 4; i += 1) expect((await login(user.email, 'Wrong@999')).status).toBe(401);
    expect((await login(user.email, password)).status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await login(user.email, 'Wrong@999')).status).toBe(401); // 4 + 4, but the success reset it
    expect((await login(user.email, password)).status).toBe(200);
    expect((await login(bystander.email, bystanderPassword)).status).toBe(200);
  });

  it('attempts older than 15 minutes expire', async () => {
    freezeClock();
    const { user, password } = await seedUser({ email: uniqueEmail('old') });
    for (let i = 0; i < 4; i += 1) await login(user.email, 'Wrong@999');
    jest.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    expect((await login(user.email, 'Wrong@999')).status).toBe(401); // the 5th failure, but the first 4 expired
    expect((await login(user.email, password)).status).toBe(200);
  });

  it('the per-IP limiter still works independently (11 different e-mails from one IP)', async () => {
    const agent = createAgent('203.0.113.77');
    for (let i = 0; i < 10; i += 1) expect((await agent.post('/auth/login').send({ email: `spray${i}@test.com`, password: 'Password@123' })).status).toBe(401);
    const res = await agent.post('/auth/login').send({ email: 'spray-final@test.com', password: 'Password@123' });
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/Too many requests/);
  });

  it('a deactivated account (right password) gives its slot back; validation errors are 422 and not counted', async () => {
    const { user, password } = await seedUser({ email: uniqueEmail('off'), isActive: false });
    for (let i = 0; i < 6; i += 1) expect((await login(user.email, password)).status).toBe(403);
    for (let i = 0; i < 8; i += 1) expect((await login(user.email, '')).status).toBe(422);
    expect((await login(user.email, password)).status).toBe(403);
    expect((await createAgent().post('/auth/login').send({ email: 'not-an-email', password: 'x' })).status).toBe(422);
    expect((await createAgent().post('/auth/login').send({})).status).toBe(422);
  });
});

// ── R-04 / R-05 ─────────────────────────────────────────────────────────────────────────────────────
describe('R-04 updateDeviceReputation never creates a document when recalculating', () => {
  it('recalculateOnly and release skip a missing document; a normal call still creates it', async () => {
    const { default: updateDeviceReputation } = await import('../utils/updateDeviceReputation.js');
    const { user } = await seedUser();
    const t = await seedTransaction({ userId: user._id, deviceId: 'ghost-dev', riskLevel: 'HIGH', status: 'HELD' });
    expect(await updateDeviceReputation('ghost-dev', user._id, t, { recalculateOnly: true })).toBeNull();
    expect(await updateDeviceReputation('ghost-dev', user._id, t, { release: true })).toBeNull();
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'ghost-dev' })).toBe(0);

    const created = await updateDeviceReputation('ghost-dev', user._id, t);
    expect(created.flagCount).toBe(1);
    expect(created.fraudTransactionCount).toBe(1);
    // an existing document IS refreshed by a recalculation (no counter change)
    const again = await updateDeviceReputation('ghost-dev', user._id, t, { recalculateOnly: true });
    expect(again.flagCount).toBe(1);
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'ghost-dev' })).toBe(1);
  });

  it('closing a case on a capped device (no reputation document) does not create one', async () => {
    const cust = await customer('r04');
    const res = await cust.agent.post('/customer-api/transactions').send(highRisk);
    await DeviceReputationModel.deleteMany({}); // as if the device had been over the cap
    const an = await analyst();
    const kase = (await an.agent.post('/analyst-api/cases').send({ fraudAlertId: res.body.data.fraudAlert.id })).body.data;
    expect((await an.agent.patch(`/analyst-api/cases/${kase._id}/assign`).send({})).status).toBe(200);
    expect((await an.agent.patch(`/analyst-api/cases/${kase._id}/status`).send({ status: 'DISMISSED', resolutionSummary: 'ok' })).status).toBe(200);
    expect(await DeviceReputationModel.countDocuments({})).toBe(0);
  });
});

describe('R-05 idempotent replay restores a missing alert', () => {
  const post = (agent, body, key) => agent.post('/customer-api/transactions').set('Idempotency-Key', key).send(body);

  it('HIGH/CRITICAL payment whose alert was never saved: the replay creates it (once) and returns its id', async () => {
    const { agent } = await customer('r05');
    const first = await post(agent, highRisk, 'key-r05-aaa');
    expect(first.status).toBe(201);
    await FraudAlertModel.deleteMany({}); // the original alert insert "failed"
    const replay = await post(agent, highRisk, 'key-r05-aaa');
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const alerts = await FraudAlertModel.find({}).lean();
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].transactionId)).toBe(first.body.data.id);
    expect(replay.body.data.fraudAlert).toEqual({ id: String(alerts[0]._id) });
    expect(alerts[0]).toMatchObject({ riskLevel: first.body.data.riskLevel, fraudScore: first.body.data.fraudScore, status: 'OPEN' });
    expect(['COMPOSITE', 'HIGH_RISK_MERCHANT', 'AMOUNT_ANOMALY']).toContain(alerts[0].alertType);

    const third = await post(agent, highRisk, 'key-r05-aaa'); // a further replay reuses it
    expect(third.body.data.fraudAlert).toEqual({ id: String(alerts[0]._id) });
    expect(await FraudAlertModel.countDocuments({})).toBe(1);
  });

  it('MEDIUM gets its alert back too; LOW never gets one; an existing alert is left alone', async () => {
    const { user, agent } = await customer('r05b');
    const medium = await seedTransaction({ userId: user._id, riskLevel: 'MEDIUM', fraudScore: 30, idempotencyKey: 'key-med-aaa', reasons: ['x'] });
    const low = await seedTransaction({ userId: user._id, idempotencyKey: 'key-low-aaa' });
    const rMed = await post(agent, txn(), 'key-med-aaa');
    expect(rMed.status).toBe(200);
    expect(rMed.body.data.fraudAlert).not.toBeNull();
    expect((await FraudAlertModel.findOne({ transactionId: medium._id })).riskLevel).toBe('MEDIUM');
    const rLow = await post(agent, txn(), 'key-low-aaa');
    expect(rLow.body.data.fraudAlert).toBeNull();
    expect(await FraudAlertModel.countDocuments({ transactionId: low._id })).toBe(0);
    const before = await FraudAlertModel.findOne({ transactionId: medium._id }).lean();
    await post(agent, txn(), 'key-med-aaa');
    expect(await FraudAlertModel.countDocuments({ transactionId: medium._id })).toBe(1);
    expect(String((await FraudAlertModel.findOne({ transactionId: medium._id }))._id)).toBe(String(before._id));
  });
});

// ── C-08 device cap ─────────────────────────────────────────────────────────────────────────────────
describe('C-08 MAX_DEVICES_PER_USER', () => {
  const original = process.env.MAX_DEVICES_PER_USER;
  afterEach(() => { if (original === undefined) delete process.env.MAX_DEVICES_PER_USER; else process.env.MAX_DEVICES_PER_USER = original; });

  it('a new device beyond the cap is scored (unknown device) and stored, but gets no DeviceReputation', async () => {
    process.env.MAX_DEVICES_PER_USER = '3';
    const a = await customer('capA');
    const post = (agent, deviceId) => agent.post('/customer-api/transactions').send(txn({ deviceId }));
    for (const id of ['dev-1', 'dev-2', 'dev-3']) expect((await post(a.agent, id)).status).toBe(201);
    expect(await DeviceReputationModel.countDocuments({})).toBe(3);

    const fourth = await post(a.agent, 'dev-4');
    expect(fourth.status).toBe(201);
    expect(fourth.body.data.reasons.join(' ')).toMatch(/unrecognised device/); // still scored as an unknown device
    expect(fourth.body.data.fraudScore).toBeGreaterThanOrEqual(20);
    expect(await TransactionModel.countDocuments({ deviceId: 'dev-4' })).toBe(1);      // the payment exists
    expect(await DeviceReputationModel.findOne({ deviceId: 'dev-4' })).toBeNull();      // the reputation does not
    expect(await DeviceReputationModel.countDocuments({})).toBe(3);

    // the same capped device again: still no document
    expect((await post(a.agent, 'dev-4')).status).toBe(201);
    expect(await DeviceReputationModel.findOne({ deviceId: 'dev-4' })).toBeNull();

    // a known device keeps being updated
    const before = await DeviceReputationModel.findOne({ deviceId: 'dev-1' }).lean();
    expect((await post(a.agent, 'dev-1')).status).toBe(201);
    const after = await DeviceReputationModel.findOne({ deviceId: 'dev-1' }).lean();
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
    expect(await TransactionModel.countDocuments({ deviceId: 'dev-1' })).toBe(2);
  });

  it('the cap is per user: another customer creates the document, and an existing document is always kept up to date', async () => {
    process.env.MAX_DEVICES_PER_USER = '2';
    const a = await customer('capA');
    const b = await customer('capB');
    const post = (agent, deviceId) => agent.post('/customer-api/transactions').send(txn({ deviceId }));
    await post(a.agent, 'a-1');
    await post(a.agent, 'a-2');
    await post(a.agent, 'a-3'); // capped
    expect(await DeviceReputationModel.findOne({ deviceId: 'a-3' })).toBeNull();

    await post(b.agent, 'a-3'); // B has no devices yet → creates it
    const doc = await DeviceReputationModel.findOne({ deviceId: 'a-3' });
    expect(doc.associatedUserIds.map(String)).toEqual([String(b.user._id)]);

    await post(a.agent, 'a-3'); // the document exists now → A is associated as well
    const shared = await DeviceReputationModel.findOne({ deviceId: 'a-3' });
    expect(shared.associatedUserIds.map(String).sort()).toEqual([String(a.user._id), String(b.user._id)].sort());
  });

  it('defaults to 20: devices 1..20 get documents, the 21st does not; countOtherDevices stops at the limit', async () => {
    delete process.env.MAX_DEVICES_PER_USER;
    const { user } = await seedUser({ email: uniqueEmail('cap20') });
    for (let i = 1; i <= 21; i += 1) {
      await processTransaction({ user, payload: txn({ deviceId: `d-${i}` }), context: { ip: '203.0.113.5' } });
    }
    expect(await DeviceReputationModel.countDocuments({ deviceId: /^d-\d+$/ })).toBe(20);
    expect(await DeviceReputationModel.findOne({ deviceId: 'd-21' })).toBeNull();
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(21);
    expect(await countOtherDevices(user._id, 'd-1', 5)).toBe(5);   // capped at the limit
    expect(await countOtherDevices(user._id, 'd-1', 50)).toBe(20); // 21 distinct ids, minus the one excluded
    expect(await countOtherDevices(new mongoose.Types.ObjectId(), 'd-1', 5)).toBe(0);
  }, 90_000);

  it('an invalid value falls back to 20 (validateEnv is what rejects it)', async () => {
    process.env.MAX_DEVICES_PER_USER = 'lots';
    const { user } = await seedUser({ email: uniqueEmail('cap-bad') });
    await processTransaction({ user, payload: txn({ deviceId: 'only-one' }), context: {} });
    expect(await DeviceReputationModel.countDocuments({ deviceId: 'only-one' })).toBe(1);
  });
});

// ── OPS: db:sync-indexes + allowDiskUse ─────────────────────────────────────────────────────────────
describe('OPS syncAllIndexes', () => {
  // (the FerretDB stand-in cannot build the TTL / partial indexes of Notification / Transaction and does not report the
  // `sparse` flag of FraudCase.publicId, which would make every run look like a change; real MongoDB has none of these limits)
  const MODELS = [UserModel, FraudAlertModel, DeviceReputationModel, BehaviorProfileModel, SystemConfigModel, AuditLogModel];

  it('creates missing indexes, drops the ones the schema no longer declares, never touches data', async () => {
    await seedUser({ email: uniqueEmail('sync') });
    await UserModel.collection.createIndex({ legacyField: 1 }, { name: 'stray_legacy' });
    await FraudAlertModel.collection.dropIndex('userId_1_status_1');
    const users = await UserModel.countDocuments({});
    const logged = [];

    const results = await syncAllIndexes(MODELS, (line) => logged.push(line));
    const byModel = Object.fromEntries(results.map((r) => [r.model, r]));
    expect(byModel.User.dropped).toEqual(['stray_legacy']);
    expect(byModel.User.created).toEqual([]);
    expect(byModel.FraudAlert.created).toEqual(['userId_1_status_1']);
    expect(byModel.FraudAlert.dropped).toEqual([]);
    expect(results).toHaveLength(MODELS.length);
    expect(logged).toHaveLength(MODELS.length);
    expect(logged.join('\n')).toMatch(/User: created \[\] dropped \[stray_legacy\]/);
    expect(await UserModel.countDocuments({})).toBe(users);

    // idempotent: a second run has nothing to do
    const second = await syncAllIndexes(MODELS, () => {});
    expect(second.every((r) => r.created.length === 0 && r.dropped.length === 0)).toBe(true);
  });

  it('the append-only AuditLog guards do not get in the way of index work', async () => {
    const [result] = await syncAllIndexes([AuditLogModel], () => {});
    expect(result.model).toBe('AuditLog');
    await AuditLogModel.createIndexes(); // must not throw (index builds are not writes through the model)
    expect((await AuditLogModel.collection.indexes()).map((i) => i.name)).toContain('timestamp_-1');
  });
});

describe('OPS allowDiskUse on the fraud-pattern aggregations', () => {
  it('all three pipelines run with allowDiskUse(true)', async () => {
    const spy = jest.spyOn(mongoose.Aggregate.prototype, 'allowDiskUse');
    const { agent } = await analyst();
    const res = await agent.get('/analyst-api/fraud-patterns');
    expect(res.status).toBe(200);
    expect(spy.mock.calls.filter(([flag]) => flag === true)).toHaveLength(3);
    expect(Object.keys(res.body.data)).toEqual(['sharedIpClusters', 'sharedDeviceClusters', 'highRiskMerchantClusters']);
  });
});
