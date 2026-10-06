// tests/admin.test.js — AdminAPI: users, thresholds (C-P4-02), simulation, audit logs, analytics
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin } from './helpers/seedUser.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { setIO, hashToken, userRoom } from '../utils/socketManager.js';
import { getZonedParts, zonedTimeToUtc } from '../config/timeZone.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

async function admin() {
  const { user, password } = await seedAdmin({ email: `admin${Date.now()}@test.com` });
  return loginAgent(user.email, password);
}

describe('Users', () => {
  it('lists users and toggles isActive (ADMIN accounts protected)', async () => {
    const agent = await admin();
    const { user: cust } = await seedUser({ email: 'toggle@test.com' });
    const list = await agent.get('/admin-api/users');
    expect(list.status).toBe(200);
    expect(list.body.pagination.limit).toBe(50); // D-P4-12
    const off = await agent.patch(`/admin-api/users/${cust._id}/status`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect((await agent.patch(`/admin-api/users/${cust._id}/status`).send({})).status).toBe(422); // body required (C-P7-07)
    const adminUser = list.body.data.find((u) => u.role === 'ADMIN');
    expect((await agent.patch(`/admin-api/users/${adminUser._id}/status`).send({ isActive: false })).status).toBe(403);
  });
});

describe('Thresholds', () => {
  it('GET returns the singleton; PATCH merges nested fields', async () => {
    const agent = await admin();
    const get = await agent.get('/admin-api/thresholds');
    expect(get.body.data.amountThreshold).toBe(50000);
    const patch = await agent.patch('/admin-api/thresholds').send({ amountThreshold: 75000, velocityLimit: { maxPerHour: 6 } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.amountThreshold).toBe(75000);
    expect(patch.body.data.velocityLimit).toMatchObject({ maxPerHour: 6, maxPerDay: 20 });
  });

  it('C-P4-02: full and partial scoreThresholds ordering violations → 422', async () => {
    const agent = await admin();
    expect((await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: 60, highMin: 50, criticalMin: 75 } })).status).toBe(422);
    expect((await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { highMin: 80 } })).status).toBe(422);
    const ok = await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: 20, highMin: 45, criticalMin: 70 } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.scoreThresholds).toMatchObject({ mediumMin: 20, highMin: 45, criticalMin: 70 });
  });

  it('non-admins get 403', async () => {
    const { user, password } = await seedUser({ email: 'nope@test.com' });
    const agent = await loginAgent(user.email, password);
    expect((await agent.patch('/admin-api/thresholds').send({ amountThreshold: 1 })).status).toBe(403);
  });
});

describe('Round-2 audit fixes (admin input handling)', () => {
  it('AUD-19: numeric strings are converted before the ordering check', async () => {
    const agent = await admin();
    expect((await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: '30', highMin: '4', criticalMin: '75' } })).status).toBe(422);
    const ok = await agent.patch('/admin-api/thresholds').send({ scoreThresholds: { mediumMin: '9', highMin: '45', criticalMin: '75' }, amountThreshold: '60000' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.scoreThresholds).toMatchObject({ mediumMin: 9, highMin: 45, criticalMin: 75 });
    expect(ok.body.data.amountThreshold).toBe(60000);
    // AUD-36 / L-14: the audit entry is a {before, after} diff of the changed keys, with nested (not dotted) values
    const logs = await agent.get('/admin-api/audit-logs?entityType=SystemConfig');
    const entry = logs.body.data.find((l) => l.action === 'THRESHOLDS_UPDATED');
    expect(entry.metadata.after).toMatchObject({ scoreThresholds: { mediumMin: 9, highMin: 45 }, amountThreshold: 60000 });
    expect(entry.metadata.before).toMatchObject({ scoreThresholds: { mediumMin: 25, highMin: 50 }, amountThreshold: 50000 });
    expect(entry.metadata.before.scoreThresholds).not.toHaveProperty('criticalMin'); // unchanged keys are not logged
    expect(entry.metadata.updatedFields).toEqual(expect.arrayContaining(['amountThreshold', 'scoreThresholds.mediumMin']));
  });

  it('AUD-19: highRiskMerchants are stored upper-case', async () => {
    const agent = await admin();
    const res = await agent.patch('/admin-api/thresholds').send({ highRiskMerchants: ['casino', ' Crypto_Exchange '] });
    expect(res.body.data.highRiskMerchants).toEqual(['CASINO', 'CRYPTO_EXCHANGE']);
  });

  it('AUD-20: isActive "false" (string) deactivates and is logged as USER_DEACTIVATED', async () => {
    const agent = await admin();
    const { user } = await seedUser({ email: 'str@test.com' });
    const res = await agent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: 'false' });
    expect(res.body).toMatchObject({ message: 'User account deactivated.', data: { isActive: false } });
    const logs = await agent.get('/admin-api/audit-logs');
    expect(logs.body.data[0].action).toBe('USER_DEACTIVATED');
  });

  it('AUD-22: the user search is literal text — "(" no longer causes a 500', async () => {
    const agent = await admin();
    await seedUser({ email: 'a.c@test.com', name: 'Dot Name' });
    await seedUser({ email: 'abc@test.com', name: 'Plain' });
    expect((await agent.get('/admin-api/users?search=(')).status).toBe(200);
    const dot = await agent.get('/admin-api/users?search=a.c@');
    expect(dot.body.data.map((u) => u.email)).toEqual(['a.c@test.com']); // '.' is not a wildcard
  });
});

describe('Round-3 audit fixes (admin analytics)', () => {
  it('AUD-38: openAlerts counts only alerts that need an analyst (HIGH/CRITICAL)', async () => {
    const agent = await admin();
    const { user, password } = await seedUser({ email: 'kpi@test.com' });
    const cust = await loginAgent(user.email, password);
    const casino = { amount: 500, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'UPI', deviceId: 'k1' };
    await cust.post('/customer-api/transactions').send(casino);                     // MEDIUM (OTP → APPROVED)
    await cust.post('/customer-api/transactions').send({ ...casino, amount: 60000 }); // HIGH
    expect((await agent.get('/admin-api/analytics')).body.data.openAlerts).toBe(1);
  });
});

describe('Simulation, audit logs, analytics', () => {
  it('simulation start/stop and audit entries', async () => {
    const agent = await admin();
    expect((await agent.post('/admin-api/simulation/start').send({ transactionCount: 5 })).status).toBe(200);
    expect((await agent.post('/admin-api/simulation/start').send({ transactionCount: 500 })).status).toBe(422);
    expect((await agent.post('/admin-api/simulation/stop')).status).toBe(200);
    const logs = await agent.get('/admin-api/audit-logs');
    const actions = logs.body.data.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['SIMULATION_STARTED', 'SIMULATION_STOPPED', 'USER_LOGIN']));
  });

  it('analytics reports hours in Asia/Kolkata (AUD-06)', async () => {
    const agent = await admin();
    const { user, password } = await seedUser({ email: 'an-cust@test.com' });
    const cust = await loginAgent(user.email, password);
    await cust.post('/customer-api/transactions').send({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'UPI', deviceId: 'd1' });
    const res = await agent.get('/admin-api/analytics');
    expect(res.status).toBe(200);
    const istHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
    expect(res.body.data.fraudByHour.map((h) => h.hour)).toContain(istHour);
    expect(res.body.data.totalTransactions).toBe(1);
    const trends = await agent.get('/admin-api/analytics/trends');
    expect(trends.status).toBe(200);
    // AUD-26: every IST day of the 30-day window is present (zero-filled)
    const { dailyTrend } = trends.body.data;
    expect(dailyTrend.length).toBeGreaterThanOrEqual(30);
    const todayIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(dailyTrend.at(-1)).toMatchObject({ date: todayIST, count: 1, movingAvg: 0.14 }); // 1 fraud in 7 days
    expect(dailyTrend.filter((d) => d.count > 0)).toHaveLength(1);
  });
});

// ── Fix round: L-14, L-13, L-05, N-14, L-06 ──────────────────────────────────────

const patch = (agent, body) => agent.patch('/admin-api/thresholds').send(body);
const config = () => SystemConfigModel.findOne({ singleton: 'system' }).lean();

describe('L-14 threshold validation', () => {
  it('maxPerDay can never be lower than maxPerHour — against the body or the stored value', async () => {
    const agent = await admin();
    const both = await patch(agent, { velocityLimit: { maxPerHour: 50, maxPerDay: 2 } });
    expect(both.status).toBe(422);
    expect(both.body.message).toMatch(/maxPerDay \(2\) must be greater than or equal to maxPerHour \(50\)/);
    expect(both.body.errors[0].msg).toBe(both.body.message);
    expect((await patch(agent, { velocityLimit: { maxPerHour: 30 } })).status).toBe(422); // stored maxPerDay is 20
    expect((await patch(agent, { velocityLimit: { maxPerDay: 3 } })).status).toBe(422);   // stored maxPerHour is 5
    expect((await config()).velocityLimit).toMatchObject({ maxPerHour: 5, maxPerDay: 20 }); // nothing was stored
    expect((await patch(agent, { velocityLimit: { maxPerHour: 10, maxPerDay: 10 } })).status).toBe(200); // equal is fine
    expect((await patch(agent, { velocityLimit: { maxPerDay: 40 } })).status).toBe(200);
  });

  it('integers only, within bounds', async () => {
    const agent = await admin();
    for (const velocityLimit of [{ maxPerHour: 6.5 }, { maxPerHour: '6.5' }, { maxPerHour: 0 }, { maxPerDay: 100001 }, { maxPerHour: [3] }, { maxPerHour: true }, { maxPerHour: 'abc' }]) {
      expect((await patch(agent, { velocityLimit })).status).toBe(422);
    }
    expect((await patch(agent, { newDeviceWeight: '33.3' })).status).toBe(422);
    expect((await patch(agent, { newDeviceWeight: 33.5 })).status).toBe(422);
    expect((await patch(agent, { newDeviceWeight: 101 })).status).toBe(422);
    expect((await patch(agent, { newDeviceWeight: -1 })).status).toBe(422);
    const ok = await patch(agent, { newDeviceWeight: '33' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.newDeviceWeight).toBe(33);
    expect((await patch(agent, { newDeviceWeight: 0 })).body.data.newDeviceWeight).toBe(0);
    expect((await patch(agent, { scoreThresholds: { mediumMin: 25.5 } })).status).toBe(422);
    expect((await patch(agent, { scoreThresholds: { highMin: 'abc' } })).status).toBe(422);
  });

  it('amountThreshold must be a finite number between 0 and 1e9', async () => {
    const agent = await admin();
    for (const amountThreshold of ['1e400', 1_000_000_001, -1, 'abc', [5], null, true, {}, '']) {
      expect((await patch(agent, { amountThreshold })).status).toBe(422);
    }
    expect((await config()).amountThreshold).toBe(50000);
    expect((await patch(agent, { amountThreshold: 0 })).body.data.amountThreshold).toBe(0);
    expect((await patch(agent, { amountThreshold: 1_000_000_000 })).body.data.amountThreshold).toBe(1_000_000_000);
    expect((await patch(agent, { amountThreshold: '12500.5' })).body.data.amountThreshold).toBe(12500.5);
    expect((await patch(agent, { locationDeviationKm: -1 })).status).toBe(422);
    expect((await patch(agent, { locationDeviationKm: 1e7 })).status).toBe(422);
    expect((await patch(agent, { locationDeviationKm: 250 })).body.data.locationDeviationKm).toBe(250);
  });

  it('highRiskMerchants: array of at most 50 non-empty strings ≤ 50 chars, normalised like the fraud rule', async () => {
    const agent = await admin();
    expect((await patch(agent, { highRiskMerchants: Array.from({ length: 51 }, (_, i) => `M${i}`) })).status).toBe(422);
    expect((await patch(agent, { highRiskMerchants: Array.from({ length: 50 }, (_, i) => `M${i}`) })).status).toBe(200);
    for (const highRiskMerchants of [[''], ['   '], ['---'], ['x'.repeat(51)], [5], [null], [['a']], 'CASINO', null, { a: 1 }]) {
      expect((await patch(agent, { highRiskMerchants })).status).toBe(422);
    }
    const ok = await patch(agent, { highRiskMerchants: ['casino', ' Pawn Shop ', 'Crypto_Exchange', 'CASINO'] });
    expect(ok.body.data.highRiskMerchants).toEqual(['CASINO', 'PAWNSHOP', 'CRYPTO_EXCHANGE']); // normalised, de-duplicated
    expect((await patch(agent, { highRiskMerchants: [] })).body.data.highRiskMerchants).toEqual([]);
  });

  it('nested groups must be objects — null, arrays and scalars are 422 (used to crash with a 500)', async () => {
    const agent = await admin();
    for (const body of [{ scoreThresholds: null }, { scoreThresholds: [] }, { scoreThresholds: 'x' }, { scoreThresholds: 5 },
      { velocityLimit: null }, { velocityLimit: [] }, { velocityLimit: 'x' }]) {
      const res = await patch(agent, body);
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/must be an object/);
    }
  });

  it('only known sub-keys are written: dotted / operator keys and unknown fields are ignored', async () => {
    const agent = await admin();
    const res = await patch(agent, { scoreThresholds: { 'a.b': 1, $set: { x: 1 }, highMin: 60 }, $where: '1', bogus: 1, velocityLimit: { 'maxPerHour.x': 3, maxPerHour: 6 } });
    expect(res.status).toBe(200);
    const stored = await config();
    expect(stored.scoreThresholds).toMatchObject({ mediumMin: 25, highMin: 60, criticalMin: 75 });
    expect(Object.keys(stored.scoreThresholds).sort()).toEqual(['criticalMin', 'highMin', 'mediumMin']);
    expect(stored.velocityLimit.maxPerHour).toBe(6);
    expect(stored).not.toHaveProperty('bogus');
    expect((await patch(agent, { $where: '1', bogus: 1 })).status).toBe(400);
  });

  it('L-13: an empty or missing body is a 400, never a 500; 422s from the merge check also carry message', async () => {
    const agent = await admin();
    expect((await agent.patch('/admin-api/thresholds')).status).toBe(400);
    const empty = await patch(agent, {});
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('No valid threshold fields provided.');
    const merge = await patch(agent, { scoreThresholds: { highMin: 80 } }); // stored criticalMin is 75
    expect(merge.status).toBe(422);
    expect(merge.body.message).toMatch(/ordering violated after merge/);
    expect(merge.body.errors[0].msg).toBe(merge.body.message);
  });

  it('THRESHOLDS_UPDATED audit stores {before, after} of the changed keys only; a no-op writes none', async () => {
    const agent = await admin();
    await patch(agent, { amountThreshold: 75000, velocityLimit: { maxPerHour: 7, maxPerDay: 20 }, highRiskMerchants: ['casino'] });
    const entry = await AuditLogModel.findOne({ action: 'THRESHOLDS_UPDATED' });
    expect(entry.metadata.before).toEqual({ amountThreshold: 50000, velocityLimit: { maxPerHour: 5 }, highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'] });
    expect(entry.metadata.after).toEqual({ amountThreshold: 75000, velocityLimit: { maxPerHour: 7 }, highRiskMerchants: ['CASINO'] }); // maxPerDay 20 → 20 unchanged
    expect(entry.metadata.updatedFields.sort()).toEqual(['amountThreshold', 'highRiskMerchants', 'velocityLimit.maxPerHour']);
    expect(entry.metadata).not.toHaveProperty('newValues');
    await patch(agent, { amountThreshold: 75000 }); // same value again
    expect(await AuditLogModel.countDocuments({ action: 'THRESHOLDS_UPDATED' })).toBe(1);
  });

  it('L-13: simulation start with no body at all uses the default count', async () => {
    const agent = await admin();
    const res = await agent.post('/admin-api/simulation/start');
    expect(res.status).toBe(200);
    expect(res.body.data.transactionCount).toBe(10);
    expect((await agent.post('/admin-api/simulation/start').send({ transactionCount: 'abc' })).status).toBe(422);
  });

  it('PATCH users/:id/status without a body is a 422 with a message', async () => {
    const agent = await admin();
    const { user } = await seedUser({ email: 'nobody@test.com' });
    const res = await agent.patch(`/admin-api/users/${user._id}/status`);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/isActive must be a boolean/);
  });
});

describe('L-06 deactivation ends the live session too', () => {
  afterEach(() => setIO({ in: () => ({ fetchSockets: async () => [] }), to: () => ({ emit() {} }), emit() {} }));

  it('deactivating a user disconnects all their sockets (and only theirs); re-activating does not', async () => {
    const agent = await admin();
    const { user } = await seedUser({ email: 'victim@test.com' });
    const { user: other } = await seedUser({ email: 'bystander@test.com' });
    const mk = (u) => ({ data: { tokenHash: hashToken('t') }, rooms: new Set([userRoom(u._id)]), disconnect: jest.fn() });
    const sockets = [mk(user), mk(user), mk(other)];
    setIO({ in: (room) => ({ fetchSockets: async () => sockets.filter((s) => s.rooms.has(room)) }), to: () => ({ emit() {} }), emit() {} });
    expect((await agent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: true })).status).toBe(200);
    expect(sockets.every((s) => s.disconnect.mock.calls.length === 0)).toBe(true);
    expect((await agent.patch(`/admin-api/users/${user._id}/status`).send({ isActive: false })).status).toBe(200);
    expect(sockets[0].disconnect).toHaveBeenCalledWith(true);
    expect(sockets[1].disconnect).toHaveBeenCalledWith(true);
    expect(sockets[2].disconnect).not.toHaveBeenCalled();
  });
});

describe('L-05 / N-14 admin date handling', () => {
  const istDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

  it('analytics: a single IST day includes late-evening transactions; invalid dates are 400', async () => {
    const agent = await admin();
    const { user } = await seedUser({ email: 'dates@test.com' });
    await seedTransaction({ userId: user._id, timestamp: new Date('2026-10-05T18:00:00Z'), riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD' }); // 23:30 IST, 5th
    await seedTransaction({ userId: user._id, timestamp: new Date('2026-10-05T19:00:00Z') });                                                                             // 00:30 IST, 6th
    const day5 = (await agent.get('/admin-api/analytics?startDate=2026-10-05&endDate=2026-10-05')).body.data;
    expect(day5.totalTransactions).toBe(1);
    expect(day5.fraudByHour).toEqual([{ hour: 23, count: 1 }]);
    expect((await agent.get('/admin-api/analytics?startDate=2026-10-06&endDate=2026-10-06')).body.data.totalTransactions).toBe(1);
    expect((await agent.get('/admin-api/analytics?startDate=2026-10-05&endDate=2026-10-06')).body.data.totalTransactions).toBe(2);
    for (const bad of ['startDate=garbage', 'endDate=2026-99-99']) {
      const res = await agent.get(`/admin-api/analytics?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid (start|end)Date/);
    }
  });

  it('audit logs: IST day filter and 400 for invalid dates', async () => {
    const agent = await admin();
    const entry = await AuditLogModel.findOne({ action: 'USER_LOGIN' });
    const day = istDay(entry.timestamp);
    expect((await agent.get(`/admin-api/audit-logs?startDate=${day}&endDate=${day}&entityType=User`)).body.data.length).toBeGreaterThan(0);
    const otherDay = istDay(new Date(entry.timestamp.getTime() + 3 * 86400000));
    expect((await agent.get(`/admin-api/audit-logs?startDate=${otherDay}&endDate=${otherDay}`)).body.data).toHaveLength(0);
    expect((await agent.get('/admin-api/audit-logs?startDate=nope')).status).toBe(400);
  });

  it('trends: the window is 31 whole IST days starting at IST midnight 30 days ago; peak hours use the same window', async () => {
    const agent = await admin();
    const { user } = await seedUser({ email: 'trend@test.com' });
    const today = getZonedParts(new Date());
    const windowStart = zonedTimeToUtc(today.year, today.month, today.day - 30);
    const high = { riskLevel: 'HIGH', status: 'HELD', fraudScore: 60, recommendedAction: 'HOLD' };
    // 01:00 IST on the first day of the window: with the old "now − 30 days" instant start this was cut off
    await seedTransaction({ userId: user._id, ...high, timestamp: new Date(windowStart.getTime() + 3600_000) });
    // 23:00 IST the day BEFORE the window, and older: outside — also for the peak hours
    await seedTransaction({ userId: user._id, ...high, timestamp: new Date(windowStart.getTime() - 3600_000) });
    await seedTransaction({ userId: user._id, ...high, timestamp: new Date(windowStart.getTime() - 5 * 86400_000 + 11 * 3600_000) });
    const res = await agent.get('/admin-api/analytics/trends');
    expect(res.status).toBe(200);
    const { dailyTrend, peakFraudHours } = res.body.data;
    expect(dailyTrend).toHaveLength(31);
    const firstDay = istDay(new Date(windowStart.getTime() + 12 * 3600_000));
    expect(dailyTrend[0].date).toBe(firstDay);
    expect(dailyTrend[0].count).toBe(1);
    expect(dailyTrend.at(-1).date).toBe(istDay(new Date()));
    expect(dailyTrend.reduce((sum, d) => sum + d.count, 0)).toBe(1);
    expect(peakFraudHours).toEqual([{ hour: 1, count: 1 }]); // only the in-window transaction (01:00 IST); the others were all-time before
    // dates are consecutive calendar days
    for (let i = 1; i < dailyTrend.length; i += 1) {
      expect(Date.parse(`${dailyTrend[i].date}T00:00:00Z`) - Date.parse(`${dailyTrend[i - 1].date}T00:00:00Z`)).toBe(86400_000);
    }
  });
});
