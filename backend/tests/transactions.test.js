// tests/transactions.test.js — CustomerAPI transaction pipeline (Phase 4 + Phase 5 + audit fixes)
import { beforeAll, afterAll, beforeEach, describe, it, expect, jest } from '@jest/globals';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';
import TransactionModel from '../models/TransactionModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import UserModel from '../models/UserModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import NotificationModel from '../models/NotificationModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import calcBehaviorProfile from '../utils/calcBehaviorProfile.js';
import generateSequentialId from '../utils/generateSequentialId.js';
import { getYearInAppZone } from '../config/timeZone.js';
import { createAgent } from './helpers/authAgent.js';
import { itAtomic } from './helpers/dbAtomicity.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const txn = (o = {}) => ({
  amount: 500,
  merchantName: 'BookStore',
  merchantCategory: 'RETAIL',
  paymentMethod: 'UPI',
  location: { city: 'Mumbai', country: 'IN' },
  deviceId: 'dev-safe',
  ...o,
});

async function customer(email = `c${Date.now()}@test.com`) {
  const { user, password } = await seedUser({ email });
  return { user, agent: await loginAgent(user.email, password) };
}

describe('POST /customer-api/transactions — fraud score paths (flat response, C-P6-33)', () => {
  beforeEach(() => seedConfig());

  it('LOW → APPROVED with a TXN-YYYY-NNNNN id', async () => {
    const { agent } = await customer();
    const res = await agent.post('/customer-api/transactions').send(txn());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ riskLevel: 'LOW', status: 'APPROVED', recommendedAction: 'APPROVE', fraudAlert: null });
    expect(res.body.data.publicId).toMatch(/^TXN-\d{4}-\d{5}$/);
  });

  it('CASINO (35 pts) → MEDIUM, OTP maps to APPROVED, alert + notification created', async () => {
    const { agent } = await customer();
    const res = await agent.post('/customer-api/transactions').send(txn({ merchantName: 'Casino Royal', merchantCategory: 'CASINO' }));
    expect(res.body.data).toMatchObject({ riskLevel: 'MEDIUM', status: 'APPROVED', recommendedAction: 'OTP' });
    expect(res.body.data.fraudAlert.id).toBeDefined();
    const unread = await agent.get('/notification-api/notifications/unread-count');
    expect(unread.body.data.unreadCount).toBe(1);
  });

  it('₹60,000 + CASINO → HIGH → HELD', async () => {
    const { agent } = await customer();
    const res = await agent.post('/customer-api/transactions').send(txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO' }));
    expect(res.body.data).toMatchObject({ riskLevel: 'HIGH', status: 'HELD' });
  });

  it('new device + high amount + CASINO → CRITICAL → BLOCKED', async () => {
    const { agent } = await customer();
    await agent.post('/customer-api/transactions').send(txn({ deviceId: 'known-device' })); // builds a profile with a known device
    const res = await agent.post('/customer-api/transactions').send(txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', deviceId: 'new-device-999' }));
    expect(res.body.data).toMatchObject({ riskLevel: 'CRITICAL', status: 'BLOCKED' });
  });

  it('accepts amount sent as a string and stores a Number (AUD-10)', async () => {
    const { agent } = await customer();
    const res = await agent.post('/customer-api/transactions').send(txn({ amount: '750.50' }));
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(750.5);
  });

  it('rejects invalid input with 422', async () => {
    const { agent } = await customer();
    expect((await agent.post('/customer-api/transactions').send(txn({ amount: -5 }))).status).toBe(422);
    expect((await agent.post('/customer-api/transactions').send(txn({ paymentMethod: 'CASH' }))).status).toBe(422);
    expect((await agent.post('/customer-api/transactions').send(txn({ deviceId: '' }))).status).toBe(422);
  });
});

describe('Behavioural logic fixed in the audit', () => {
  beforeEach(() => seedConfig());

  it('AUD-02: one HELD transaction does not blacklist the device forever', async () => {
    const { agent } = await customer();
    const held = await agent.post('/customer-api/transactions').send(txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', deviceId: 'dev-B' }));
    expect(held.body.data.status).toBe('HELD');
    const device = await DeviceReputationModel.findOne({ deviceId: 'dev-B' });
    expect(device.reputationScore).toBe(88); // (0 + 0.5×1 + 3) / (1 + 3)
    expect(device.isBlacklisted).toBe(false);
    const normal = await agent.post('/customer-api/transactions').send(txn({ deviceId: 'dev-B' }));
    expect(normal.body.data.riskLevel).toBe('LOW');
  });

  it('AUD-02: a device with many blocked transactions IS blacklisted', async () => {
    const { user } = await customer();
    for (let i = 0; i < 10; i += 1) {
      await seedTransaction({ userId: user._id, deviceId: 'dev-bad', status: 'BLOCKED', riskLevel: 'CRITICAL', fraudScore: 90, recommendedAction: 'BLOCK' });
    }
    const { default: updateDeviceReputation } = await import('../utils/updateDeviceReputation.js');
    const rep = await updateDeviceReputation('dev-bad', user._id, { riskLevel: 'CRITICAL' });
    expect(rep.reputationScore).toBe(23); // 3 / 13
    expect(rep.isBlacklisted).toBe(true);
  });

  it('AUD-03: velocity is counted live — old bursts do not flag today', async () => {
    const { user, agent } = await customer();
    for (let i = 0; i < 5; i += 1) await agent.post('/customer-api/transactions').send(txn());
    await TransactionModel.updateMany({ userId: user._id }, { $set: { timestamp: new Date(Date.now() - 2 * 24 * 3600 * 1000) } });
    const res = await agent.post('/customer-api/transactions').send(txn());
    expect(res.body.data.reasons.filter((r) => /velocity/i.test(r))).toHaveLength(0);
  });

  it('C-P5-01 + AUD-03: the 6th transaction within an hour IS flagged (>= limit)', async () => {
    const { agent } = await customer();
    for (let i = 0; i < 5; i += 1) await agent.post('/customer-api/transactions').send(txn());
    const res = await agent.post('/customer-api/transactions').send(txn());
    expect(res.body.data.reasons.some((r) => /hourly velocity: 5/i.test(r))).toBe(true);
  });

  it('AUD-09: trust score is recalculated after each transaction', async () => {
    const { user, agent } = await customer();
    await agent.post('/customer-api/transactions').send(txn());
    expect((await UserModel.findById(user._id)).trustScore).toBe(67); // (1 + 1) / (1 + 2)
    await agent.post('/customer-api/transactions').send(txn({ amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', deviceId: 'dev-new' }));
    const after = (await agent.get('/customer-api/trust-score')).body.data.trustScore;
    expect(after).toBeLessThan(67);
  });

  it('AUD-05: concurrent submissions get unique TXN ids and no orphans', async () => {
    const { agent } = await customer();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => agent.post('/customer-api/transactions').send(txn({ amount: 100 + i })))
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = results.map((r) => r.body.data.publicId);
    expect(new Set(ids).size).toBe(10);
    expect(await TransactionModel.countDocuments({ publicId: { $in: [null] } })).toBe(0);
  });
});

describe('Round-2 audit fixes', () => {
  beforeEach(() => seedConfig());

  it('AUD-18: admin-configured thresholds are used for scoring (not the defaults)', async () => {
    const { agent } = await customer();
    // ₹5,000 is below the default ₹50,000 threshold → LOW with defaults
    expect((await agent.post('/customer-api/transactions').send(txn({ amount: 5000 }))).body.data.riskLevel).toBe('LOW');
    await SystemConfigModel.updateOne({ singleton: 'system' }, { $set: {
      amountThreshold: 1000, scoreThresholds: { mediumMin: 10, highMin: 20, criticalMin: 30 },
    } });
    const res = await agent.post('/customer-api/transactions').send(txn({ amount: 5000 }));
    expect(res.body.data.reasons.join(' ')).toMatch(/exceeds high-value threshold ₹1,000/);
    expect(res.body.data.riskLevel).toBe('HIGH'); // 20 pts ≥ custom highMin 20
  });

  it('AUD-27: rejects an amount above the upper bound (no Infinity)', async () => {
    const { agent } = await customer();
    expect((await agent.post('/customer-api/transactions').send(txn({ amount: '1e400' }))).status).toBe(422);
    expect((await agent.post('/customer-api/transactions').send(txn({ amount: 1_000_000_001 }))).status).toBe(422);
  });

  it('AUD-29: a document that fails model validation does not consume a TXN number', async () => {
    const { user } = await customer();
    await expect(seedTransaction({ userId: user._id, riskLevel: 'BOGUS' })).rejects.toThrow(/Risk level/);
    const ok = await seedTransaction({ userId: user._id });
    expect(ok.publicId).toMatch(/-00001$/);
  });

  it('AUD-21: malformed page/limit fall back to safe values', async () => {
    const { agent } = await customer();
    for (const q of ['page=0', 'page=abc', 'limit=0', 'limit=-5']) {
      const res = await agent.get(`/customer-api/transactions?${q}`);
      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBeGreaterThanOrEqual(1);
      expect(res.body.pagination.limit).toBeGreaterThanOrEqual(1);
    }
    expect((await agent.get('/customer-api/transactions?limit=5000')).body.pagination.limit).toBe(100);
  });
});

describe('Round-3 audit fixes', () => {
  it('AUD-37: a HELD transaction does not become part of the normal-behaviour profile', async () => {
    await seedConfig({ velocityLimit: { maxPerHour: 100, maxPerDay: 100 } }); // isolate from velocity
    const { agent } = await customer();
    for (let i = 0; i < 4; i += 1) await agent.post('/customer-api/transactions').send(txn({ amount: 1000, deviceId: 'DA' }));
    const attack = txn({ amount: 60000, location: { city: 'Delhi', country: 'IN' }, deviceId: 'DB' });
    const first = await agent.post('/customer-api/transactions').send(attack);
    expect(first.body.data.status).toBe('HELD');
    const second = await agent.post('/customer-api/transactions').send(attack);
    const third = await agent.post('/customer-api/transactions').send(attack);
    expect(second.body.data).toMatchObject({ riskLevel: 'HIGH', status: 'HELD' }); // was MEDIUM → APPROVED
    expect(third.body.data).toMatchObject({ riskLevel: 'HIGH', status: 'HELD' });  // was LOW → APPROVED, no alert
  });
});

describe('GET /customer-api/transactions and /:id', () => {
  it('returns a paginated list scoped to the caller', async () => {
    const { user, agent } = await customer('list@test.com');
    const { user: other } = await seedUser({ email: 'other@test.com' });
    await seedTransaction({ userId: user._id, amount: 100 });
    await seedTransaction({ userId: user._id, amount: 200 });
    await seedTransaction({ userId: other._id, amount: 999 });
    const res = await agent.get('/customer-api/transactions?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 10, total: 2, pages: 1 });
  });

  it('GET /:id takes the Mongo _id and returns { transaction, deviceReputation }', async () => {
    const { user, agent } = await customer('detail@test.com');
    const t = await seedTransaction({ userId: user._id });
    const res = await agent.get(`/customer-api/transactions/${t._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.transaction.publicId).toBe(t.publicId);
    expect(res.body.data).toHaveProperty('deviceReputation');
  });

  it('GET /:id returns 404 for someone else’s transaction and 400 for a malformed id', async () => {
    const { agent } = await customer('scoped@test.com');
    const { user: other } = await seedUser({ email: 'owner@test.com' });
    const t = await seedTransaction({ userId: other._id });
    expect((await agent.get(`/customer-api/transactions/${t._id}`)).status).toBe(404);
    expect((await agent.get('/customer-api/transactions/not-an-id')).status).toBe(400);
  });
});

// ── Fix round ────────────────────────────────────────────────────────────────────

const casinoTxn = (o = {}) => txn({ merchantName: 'Casino Royal', merchantCategory: 'CASINO', ...o });
const post = (agent, body) => agent.post('/customer-api/transactions').send(body);

describe('L-01 MEDIUM (approved, no OTP) never teaches the trusted baseline', () => {
  beforeEach(() => seedConfig({ velocityLimit: { maxPerHour: 100, maxPerDay: 100 } })); // isolate from velocity

  it('a MEDIUM transaction is APPROVED with an alert but creates no behaviour profile', async () => {
    const { user, agent } = await customer();
    const res = await post(agent, casinoTxn({ deviceId: 'attacker-dev', location: { city: 'Delhi', country: 'IN' } }));
    expect(res.body.data).toMatchObject({ riskLevel: 'MEDIUM', status: 'APPROVED', recommendedAction: 'OTP' });
    expect(res.body.data.fraudAlert.id).toBeDefined();
    expect(await BehaviorProfileModel.countDocuments({ userId: user._id })).toBe(0);
  });

  it('the attack from the report: new device + new city stays MEDIUM on every repeat and never becomes "usual"', async () => {
    const { user, agent } = await customer();
    for (let i = 0; i < 4; i += 1) expect((await post(agent, txn({ amount: 1000, deviceId: 'DA' }))).body.data.riskLevel).toBe('LOW');
    const attack = txn({ amount: 1000, deviceId: 'DB', location: { city: 'Delhi', country: 'IN' } });
    for (let i = 0; i < 3; i += 1) {
      const res = await post(agent, attack);
      expect(res.body.data).toMatchObject({ riskLevel: 'MEDIUM', status: 'APPROVED', fraudScore: 35 }); // used to fall to LOW / score 0 on repeat
      expect(res.body.data.fraudAlert).not.toBeNull();
    }
    const profile = await BehaviorProfileModel.findOne({ userId: user._id });
    expect(profile.knownDeviceIds).toEqual(['DA']);
    expect(profile.usualLocations).toEqual(['Mumbai']);
    // legitimate behaviour keeps being learned: a LOW transaction recomputes the profile WITHOUT the MEDIUM ones
    expect((await post(agent, txn({ amount: 3000, deviceId: 'DA' }))).body.data.riskLevel).toBe('LOW');
    const after = await BehaviorProfileModel.findOne({ userId: user._id });
    expect(after.knownDeviceIds).toEqual(['DA']);
    expect(after.usualLocations).toEqual(['Mumbai']);
    expect(after.avgTransactionAmount).toBe((4 * 1000 + 3000) / 5);
    expect(after.maxTransactionAmount).toBe(3000);
  });

  it('calcBehaviorProfile uses APPROVED + LOW transactions only', async () => {
    const { user } = await customer();
    await seedTransaction({ userId: user._id, amount: 100, deviceId: 'low-dev', location: { city: 'Pune', country: 'IN' } });
    await seedTransaction({ userId: user._id, amount: 900, deviceId: 'med-dev', riskLevel: 'MEDIUM', location: { city: 'Goa', country: 'IN' } });
    await seedTransaction({ userId: user._id, amount: 800, deviceId: 'held-dev', riskLevel: 'HIGH', status: 'HELD', location: { city: 'Agra', country: 'IN' } });
    const last = await seedTransaction({ userId: user._id, amount: 300, deviceId: 'low-dev', location: { city: 'pune', country: 'IN' } });
    const profile = await calcBehaviorProfile(user._id, last);
    expect(profile.avgTransactionAmount).toBe(200);
    expect(profile.maxTransactionAmount).toBe(300);
    expect(profile.knownDeviceIds).toEqual(['low-dev']);
    expect(profile.usualLocations).toEqual(['Pune']);        // first-seen spelling, "pune" merged into it
    expect(profile.transactionVelocity).toMatchObject({ perHour: 4, perDay: 4 }); // velocity = ALL outcomes, like the fraud check
    expect(profile.usualHours.every((h) => h >= 0 && h <= 23)).toBe(true);
  });

  it('returns null (and writes nothing) when nothing qualifies — the old bootstrap branch was dead code', async () => {
    const { user } = await customer();
    const held = await seedTransaction({ userId: user._id, status: 'HELD', riskLevel: 'HIGH' });
    expect(await calcBehaviorProfile(user._id, held)).toBeNull();
    expect(await BehaviorProfileModel.countDocuments({ userId: user._id })).toBe(0);
  });
});

describe('L-08 / N-28 one submission at a time per user', () => {
  beforeEach(() => seedConfig());

  it('12 simultaneous payments of ONE user see each other: velocity is flagged from the 6th on', async () => {
    const { user, agent } = await customer();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(agent, txn({ amount: 100 + i }))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const flagged = results.filter((r) => r.body.data.reasons.some((x) => /hourly velocity/i.test(x)));
    expect(flagged).toHaveLength(7); // prior counts 5..11 are ≥ the limit of 5
    expect(new Set(results.map((r) => r.body.data.publicId)).size).toBe(12);
    // derived scores were written in order: the final state reflects all 12
    const trust = (await agent.get('/customer-api/trust-score')).body.data;
    expect(trust.trustScore).toBe((await UserModel.findById(user._id)).trustScore);
    const device = await DeviceReputationModel.findOne({ deviceId: 'dev-safe' });
    expect(device.associatedUserIds.map(String)).toEqual([String(user._id)]);
  });

  // (needs a database that survives concurrent first-use upserts of the id counter; the lock
  //  itself is proven independent per key in units.test.js)
  itAtomic('different users are NOT serialised behind each other', async () => {
    const [a, b] = await Promise.all([customer(`la${Date.now()}@test.com`), customer(`lb${Date.now()}@test.com`)]);
    const results = await Promise.all([
      ...Array.from({ length: 3 }, (_, i) => post(a.agent, txn({ amount: 10 + i }))),
      ...Array.from({ length: 3 }, (_, i) => post(b.agent, txn({ amount: 20 + i, deviceId: 'dev-b' }))),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await TransactionModel.countDocuments({ userId: a.user._id })).toBe(3);
    expect(await TransactionModel.countDocuments({ userId: b.user._id })).toBe(3);
  });

  it('a failing request releases the lock: the next one is processed', async () => {
    const { agent } = await customer();
    const spy = jest.spyOn(TransactionModel, 'countDocuments').mockRejectedValueOnce(new Error('db hiccup'));
    const failed = await post(agent, txn());
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect((await post(agent, txn())).status).toBe(201);
  });
});

describe('L-10 / N-26 transaction input validation', () => {
  beforeEach(() => seedConfig());

  it('non-string / oversized / malformed fields are 422 with a message — and nothing is stored', async () => {
    const { agent, user } = await customer();
    const bad = [
      [{ merchantCategory: ['CASINO'] }, /Merchant category must be a string/],   // used to crash with a 500
      [{ merchantCategory: { a: 1 } }, /Merchant category must be a string/],
      [{ merchantCategory: 123 }, /Merchant category must be a string/],
      [{ merchantCategory: 'x'.repeat(51) }, /cannot exceed 50/],
      [{ merchantName: { a: 1 } }, /Merchant name must be a string/],
      [{ merchantName: 12345 }, /Merchant name must be a string/],
      [{ merchantName: 'm'.repeat(201) }, /cannot exceed 200/],
      [{ deviceId: { $gt: '' } }, /Device ID must be a string/],
      [{ deviceId: ['a'] }, /Device ID must be a string/],
      [{ deviceId: 'd'.repeat(129) }, /cannot exceed 128/],
      [{ paymentMethod: ['UPI'] }, /Payment method must be/],
      [{ location: null }, /Location must be an object/],
      [{ location: 'Mumbai' }, /Location must be an object/],
      [{ location: ['Mumbai'] }, /Location must be an object/],
      [{ location: { city: { a: 1 } } }, /Location city must be a string/],
      [{ location: { city: 'c'.repeat(101) } }, /cannot exceed 100/],
      [{ location: { country: 'c'.repeat(101) } }, /cannot exceed 100/],
      [{ location: { city: '   ' } }, /cannot be an empty string/],
      [{ amount: [5] }, /Amount must be a number/],
      [{ amount: { a: 1 } }, /Amount must be a number/],
      [{ amount: true }, /Amount must be a number/],
    ];
    for (const [override, message] of bad) {
      const res = await post(agent, txn(override));
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(message);
      expect(res.body.message).toBe(res.body.errors[0].msg);
    }
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(0);
    expect(await DeviceReputationModel.countDocuments({})).toBe(0); // no junk reputation rows
  });

  it('the limits themselves are accepted and values are trimmed', async () => {
    const { agent } = await customer();
    const res = await post(agent, txn({
      merchantName: `  ${'m'.repeat(200)}  `, merchantCategory: ` ${'c'.repeat(50)} `, deviceId: ` ${'d'.repeat(128)} `,
      location: { city: ` ${'x'.repeat(100)} `, country: 'y'.repeat(100) },
    }));
    expect(res.status).toBe(201);
    const stored = await TransactionModel.findById(res.body.data.id);
    expect(stored.merchantName).toBe('m'.repeat(200));
    expect(stored.deviceId).toBe('d'.repeat(128));
    expect(stored.location.city).toBe('x'.repeat(100));
  });

  it('unknown keys inside location are not stored', async () => {
    const { agent } = await customer();
    const res = await post(agent, txn({ location: { city: 'Mumbai', country: 'IN', lat: 1, __proto__x: 'y' } }));
    expect(res.status).toBe(201);
    expect((await TransactionModel.findById(res.body.data.id)).location.toObject()).toEqual({ city: 'Mumbai', country: 'IN' });
  });

  it('L-13: a request with no body at all is a 422 (not a 500)', async () => {
    const { agent } = await customer();
    const res = await agent.post('/customer-api/transactions');
    expect(res.status).toBe(422);
    expect(res.body.message).toBeTruthy();
  });
});

describe('L-15 scoring consistency', () => {
  beforeEach(() => seedConfig({ velocityLimit: { maxPerHour: 100, maxPerDay: 100 } }));

  it('merchant category matching ignores case, spaces and punctuation; the reason shows the normalised category', async () => {
    const { agent } = await customer();
    for (const merchantCategory of ['casino', 'CASI NO', ' Casino! ', 'cAsInO']) {
      const res = await post(agent, txn({ merchantCategory }));
      expect(res.body.data.fraudScore).toBe(35);
      expect(res.body.data.reasons).toContain('High-risk merchant category detected: CASINO');
    }
    expect((await post(agent, txn({ merchantCategory: 'crypto exchange' }))).body.data.fraudScore).toBe(35); // X-1: "crypto exchange" matches the configured CRYPTO_EXCHANGE
    expect((await post(agent, txn({ merchantCategory: 'crypto_exchange' }))).body.data.fraudScore).toBe(35);
  });

  it('a stored high-risk entry in any spelling still matches', async () => {
    await SystemConfigModel.updateOne({ singleton: 'system' }, { $set: { highRiskMerchants: ['Pawn Shop', 'crypto_exchange'] } });
    const { agent } = await customer();
    expect((await post(agent, txn({ merchantCategory: 'PAWNSHOP' }))).body.data.fraudScore).toBe(35);
  });

  it('city comparison is case- and whitespace-insensitive; the stored spelling is kept for display', async () => {
    const { user, agent } = await customer();
    await post(agent, txn({ location: { city: 'Mumbai', country: 'IN' } }));
    const same = await post(agent, txn({ location: { city: '  mumbai ', country: 'IN' } }));
    expect(same.body.data.reasons.filter((r) => /unusual city/.test(r))).toHaveLength(0);
    expect(same.body.data.fraudScore).toBe(0);
    const profile = await BehaviorProfileModel.findOne({ userId: user._id });
    expect(profile.usualLocations).toEqual(['Mumbai']); // "  mumbai " did not add a second entry
    const other = await post(agent, txn({ location: { city: 'Delhi', country: 'IN' } }));
    expect(other.body.data.reasons.some((r) => /unusual city: Delhi/.test(r))).toBe(true);
  });

  it('reasons and notifications format rupees the Indian way (en-IN), whatever the server locale', async () => {
    const { agent } = await customer();
    await SystemConfigModel.updateOne({ singleton: 'system' }, { $set: { amountThreshold: 1000 } });
    const res = await post(agent, txn({ amount: 999999999, merchantCategory: 'CASINO' }));
    expect(res.body.data.reasons[0]).toBe('Transaction amount ₹99,99,99,999 exceeds high-value threshold ₹1,000');
    const note = await NotificationModel.findOne({ type: 'FRAUD_ALERT' });
    expect(note.message).toMatch(/^Your transaction of ₹99,99,99,999 at BookStore was flagged\./);
    // averages never print long decimals
    await post(agent, txn({ amount: 100 })); await post(agent, txn({ amount: 100 })); await post(agent, txn({ amount: 101 }));
    const big = await post(agent, txn({ amount: 5000 }));
    expect(big.body.data.reasons.join(' ')).toMatch(/× the user's average ₹\d{2,3}(\.\d{1,2})?(?!\d)/);
  });

  it('GET /trust-score reports LIVE velocity (all outcomes), not the stored snapshot', async () => {
    const { user, agent } = await customer();
    expect((await agent.get('/customer-api/trust-score')).body.data.behaviorSummary).toBeNull(); // no profile yet
    for (let i = 0; i < 3; i += 1) await post(agent, txn());
    await post(agent, txn({ amount: 60000, merchantCategory: 'CASINO', deviceId: 'dev-other' })); // HELD: not in the profile
    await BehaviorProfileModel.updateOne({ userId: user._id }, { $set: { transactionVelocity: { perHour: 0, perDay: 0 } } }); // stale snapshot
    const summary = (await agent.get('/customer-api/trust-score')).body.data.behaviorSummary;
    expect(summary.transactionVelocity).toEqual({ perHour: 4, perDay: 4 });
    expect(Object.keys(summary)).toEqual(expect.arrayContaining(['avgTransactionAmount', 'maxTransactionAmount', 'transactionVelocity', 'usualLocations', 'usualPaymentMethods', 'lastUpdated']));
    // and old transactions drop out of the hourly count
    await TransactionModel.updateMany({ userId: user._id }, { $set: { timestamp: new Date(Date.now() - 2 * 3600 * 1000) } });
    expect((await agent.get('/customer-api/trust-score')).body.data.behaviorSummary.transactionVelocity).toEqual({ perHour: 0, perDay: 4 });
  });

  it('the alert type comes from the rules that fired (no reason-text parsing)', async () => {
    const { agent } = await customer();
    // HIGH_RISK_MERCHANT alone
    const merchant = await post(agent, casinoTxn());
    expect((await FraudAlertModel.findById(merchant.body.data.fraudAlert.id)).alertType).toBe('HIGH_RISK_MERCHANT');
    // merchant + amount rules together → COMPOSITE
    const both = await post(agent, casinoTxn({ amount: 60000 }));
    expect((await FraudAlertModel.findById(both.body.data.fraudAlert.id)).alertType).toBe('COMPOSITE');
  });

  it('one rule with several reasons is still ONE alert type (hourly + daily velocity → VELOCITY_BREACH)', async () => {
    // velocity rule alone caps at 20 points, so lower mediumMin to let it raise an alert
    await seedConfig({ velocityLimit: { maxPerHour: 1, maxPerDay: 1 }, scoreThresholds: { mediumMin: 15 } });
    const { agent } = await customer();
    await post(agent, txn());
    const second = await post(agent, txn());
    expect(second.body.data.reasons.filter((r) => /velocity/i.test(r))).toHaveLength(2);
    expect(second.body.data.riskLevel).toBe('MEDIUM');
    expect((await FraudAlertModel.findById(second.body.data.fraudAlert.id)).alertType).toBe('VELOCITY_BREACH');
  });

  it('an amount-only alert is AMOUNT_ANOMALY', async () => {
    await SystemConfigModel.updateOne({ singleton: 'system' }, { $set: { amountThreshold: 1000, scoreThresholds: { mediumMin: 10, highMin: 60, criticalMin: 80 } } });
    const { agent } = await customer();
    const res = await post(agent, txn({ amount: 5000 }));
    expect(res.body.data.riskLevel).toBe('MEDIUM');
    expect((await FraudAlertModel.findById(res.body.data.fraudAlert.id)).alertType).toBe('AMOUNT_ANOMALY');
  });
});

describe('BE-5 / BS-19 post-commit helpers', () => {
  beforeEach(() => seedConfig());

  it('a failing profile / reputation / trust-score update does not turn a saved transaction into a 500', async () => {
    const { user, agent } = await customer();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spies = [
      jest.spyOn(BehaviorProfileModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('profile boom')),
      jest.spyOn(DeviceReputationModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('reputation boom')),
      jest.spyOn(UserModel, 'updateOne').mockRejectedValueOnce(new Error('trust boom')),
    ];
    const res = await post(agent, txn());
    spies.forEach((spy) => spy.mockRestore());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('APPROVED');
    expect(await TransactionModel.countDocuments({ userId: user._id })).toBe(1);
    const logged = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/behaviour profile update failed/);
    expect(logged).toMatch(/device reputation update failed/);
    expect(logged).toMatch(/trust score update failed/);
    err.mockRestore();
    expect((await post(agent, txn())).status).toBe(201); // and the next one works
  });

  it('a failing notification does not break a flagged submission; the alert and audit entries still exist', async () => {
    const { user, agent } = await customer();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(NotificationModel, 'create').mockRejectedValueOnce(new Error('notify boom'));
    const res = await post(agent, casinoTxn());
    spy.mockRestore(); err.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.data.fraudAlert.id).toBeDefined();
    expect(await NotificationModel.countDocuments({ recipientId: user._id })).toBe(0);
    const audit = await AuditLogModel.findOne({ action: 'FRAUD_ALERT_CREATED' });
    expect(String(audit.actorId)).toBe(String(user._id));
    expect(audit.entityId).toBe(res.body.data.fraudAlert.id);
    expect(audit.metadata).toMatchObject({ transactionId: res.body.data.publicId, alertType: 'HIGH_RISK_MERCHANT', riskLevel: 'MEDIUM', fraudScore: 35 });
  });
});

describe('L-12 transaction limiter is keyed by user, not by IP', () => {
  it('one customer hitting the limit does not block another customer behind the same IP', async () => {
    await seedConfig();
    const ip = '203.0.113.77';
    const mk = async (email) => {
      const { user, password } = await seedUser({ email });
      const agent = createAgent(ip);
      await agent.post('/auth/login').send({ email: user.email, password });
      return agent;
    };
    const noisy = await mk('noisy@test.com');
    const calm = await mk('calm@test.com');
    for (let i = 0; i < 30; i += 1) expect((await noisy.post('/customer-api/transactions').send({})).status).toBe(422); // counted even when invalid
    const blocked = await noisy.post('/customer-api/transactions').send(txn());
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/Transaction rate limit exceeded/);
    expect((await calm.post('/customer-api/transactions').send(txn())).status).toBe(201);
  });
});

describe('L-05 customer date filters (Asia/Kolkata days)', () => {
  it('a single "YYYY-MM-DD" day covers the whole IST day; ISO strings are exact; invalid → 400', async () => {
    const { user, agent } = await customer();
    const lateOn5th = await seedTransaction({ userId: user._id, amount: 1, timestamp: new Date('2026-10-05T18:00:00Z') }); // 23:30 IST, 5th
    const earlyOn6th = await seedTransaction({ userId: user._id, amount: 2, timestamp: new Date('2026-10-05T19:00:00Z') }); // 00:30 IST, 6th
    const ids = async (q) => (await agent.get(`/customer-api/transactions?${q}`)).body.data.map((t) => t.publicId);
    expect(await ids('startDate=2026-10-05&endDate=2026-10-05')).toEqual([lateOn5th.publicId]); // used to be empty
    expect(await ids('startDate=2026-10-06&endDate=2026-10-06')).toEqual([earlyOn6th.publicId]);
    expect((await ids('startDate=2026-10-05&endDate=2026-10-06')).sort()).toEqual([lateOn5th.publicId, earlyOn6th.publicId].sort());
    expect(await ids('startDate=2026-10-05')).toHaveLength(2);
    expect(await ids('endDate=2026-10-05')).toEqual([lateOn5th.publicId]);
    expect(await ids(`startDate=${encodeURIComponent('2026-10-05T18:30:00+05:30')}`)).toEqual([earlyOn6th.publicId, lateOn5th.publicId]); // newest first
    expect(await ids(`startDate=${encodeURIComponent('2026-10-05T23:45:00+05:30')}`)).toEqual([earlyOn6th.publicId]);
    for (const bad of ['startDate=yesterday', 'endDate=2026-13-45', 'startDate=2026-02-30']) {
      const res = await agent.get(`/customer-api/transactions?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid (start|end)Date/);
    }
  });
});

describe('L-15 public ID sequence beyond 99,999', () => {
  it('ids keep growing (TXN-YYYY-100000), the model accepts them and the max lookup is numeric', async () => {
    const { user } = await customer();
    const year = getYearInAppZone();
    await TransactionModel.collection.insertOne({ ...(await seedTransaction({ userId: user._id })).toObject(), _id: new (await import('mongoose')).default.Types.ObjectId(), publicId: `TXN-${year}-99999` });
    await clearCountersOnly();
    const next = await seedTransaction({ userId: user._id });
    expect(next.publicId).toBe(`TXN-${year}-100000`);
    const after = await seedTransaction({ userId: user._id });
    expect(after.publicId).toBe(`TXN-${year}-100001`);
    // counter lost (e.g. restored database): the highest existing id — six digits — is still found
    await clearCountersOnly();
    expect((await seedTransaction({ userId: user._id })).publicId).toBe(`TXN-${year}-100002`);
    expect(await generateSequentialId(TransactionModel, 'publicId', 'TXN')).toBe(`TXN-${year}-100003`);
    // five-digit ids are unchanged
    expect((await TransactionModel.findOne({ publicId: `TXN-${year}-99999` })).publicId).toMatch(/^TXN-\d{4}-\d{5}$/);
  });
});

async function clearCountersOnly() {
  await TransactionModel.db.collection('counters').deleteMany({});
}

describe('L-15 indexes', () => {
  it('the new indexes exist', async () => {
    const has = async (Model, key) => (await Model.collection.indexes()).some((i) => JSON.stringify(i.key) === JSON.stringify(key));
    const { default: FraudAlert } = await import('../models/FraudAlertModel.js');
    const { default: AuditLog } = await import('../models/AuditLogModel.js');
    expect(await has(TransactionModel, { deviceId: 1 })).toBe(true);
    expect(await has(TransactionModel, { riskLevel: 1, timestamp: -1 })).toBe(true);
    expect(await has(FraudAlert, { transactionId: 1 })).toBe(true);
    expect(await has(AuditLog, { timestamp: -1 })).toBe(true);
  });
});

describe('round 2: alert creation failure after the transaction was saved', () => {
  const casino = { amount: 60000, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'CARD', deviceId: 'dev-r2' };
  const submit = async (failures) => {
    const c = await seedUser({ email: `r2alert${failures}${Date.now()}@test.com` });
    const customer = await loginAgent(c.user.email, c.password);
    const spy = jest.spyOn(FraudAlertModel, 'create');
    for (let i = 0; i < failures; i += 1) spy.mockRejectedValueOnce(new Error('alert insert failed'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await customer.post('/customer-api/transactions').send(casino);
    spy.mockRestore();
    quiet.mockRestore();
    return { res, userId: c.user._id };
  };

  it('one failed insert is retried, so the payment still gets its alert', async () => {
    const { res } = await submit(1);
    expect(res.status).toBe(201);
    expect(res.body.data.fraudAlert).toHaveProperty('id');
  });

  it('two failed inserts still answer 201 (no 500, so no double payment); the transaction is kept, fraudAlert is null', async () => {
    const { res, userId } = await submit(2);
    expect(res.status).toBe(201);
    expect(['HIGH', 'CRITICAL']).toContain(res.body.data.riskLevel);
    expect(res.body.data.fraudAlert).toBeNull();
    expect(await TransactionModel.countDocuments({ userId })).toBe(1);
  });
});

describe('round 2: validation errors never echo submitted values', () => {
  it('422 errors carry path/msg but no `value` (a password must not come back)', async () => {
    const res = await createAgent().post('/auth/register').send({ name: 'Zed', email: 'zed@test.com', password: 'short-pw-1' });
    expect(res.status).toBe(422);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('short-pw-1');
    expect(res.body.errors[0]).toHaveProperty('path');
    expect(res.body.errors[0]).toHaveProperty('msg');
  });
});
