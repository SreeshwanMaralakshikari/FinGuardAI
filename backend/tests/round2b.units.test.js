// tests/round2b.units.test.js — fix round 2b: pure unit tests (no database)
//   A-04 forecast · C-04/C-08 ops settings + index definitions · D-02 login throttle · A-08 scenario plan · B-07 band rule · OPS config
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import validateEnv, { getNodeEnvWarnings } from '../config/validateEnv.js';
import { describeEnvironment } from '../config/environment.js';
import {
  getNotificationTtlSeconds, getAuditLogTtlSeconds, getMaxDevicesPerUser, validateOpsSettings,
} from '../config/opsSettings.js';
import {
  linearRegression, predictNext, buildForecast, FORECAST_METHOD,
} from '../utils/forecast.js';
import {
  MAX_FAILURES, EMAIL_MAX_FAILURES, WINDOW_MS, MAX_KEYS, getLockoutRemainingMs, reserveLoginAttempt, releaseLoginAttempt,
  clearLoginFailures, resetLoginThrottle, trackedPairKeys, trackedEmailKeys, loginAccountThrottle,
} from '../utils/loginThrottle.js';
import { riskLevelForScore, defaultScoreThresholds, checkFraud } from '../services/fraudDetectionService.js';
import { scenarioQuotas, planRun, buildPayload, createRng, SCENARIO_WEIGHTS } from '../services/simulationService.js';
import { assertSyncConfig } from '../seed/syncIndexes.js';
import NotificationModel from '../models/NotificationModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { ALERT_STATUSES, AUDIT_ACTIONS } from '../utils/enums.js';

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── A-04 forecast helper ────────────────────────────────────────────────────────────────────────────
describe('A-04 utils/forecast.js', () => {
  it('linearRegression is ordinary least squares on x = 0..n-1 (exact on a straight line)', () => {
    expect(linearRegression([1, 3, 5, 7])).toEqual({ slope: 2, intercept: 1 });
    const flat = linearRegression([4, 4, 4]);
    expect(flat.slope).toBe(0);
    expect(flat.intercept).toBe(4);
  });

  it('matches a hand-computed OLS fit on noisy data', () => {
    // textbook example (x = 1..5 gives 0.6 / 2.2); with x = 0..4 the intercept is mean(y) - 0.6 * 2 = 2.8
    const { slope, intercept } = linearRegression([2, 4, 5, 4, 5]);
    expect(slope).toBeCloseTo(0.6, 10);
    expect(intercept).toBeCloseTo(2.8, 10);
  });

  it('handles the degenerate sizes without NaN', () => {
    expect(linearRegression([])).toEqual({ slope: 0, intercept: 0 });
    expect(linearRegression([9])).toEqual({ slope: 0, intercept: 9 });
  });

  it('predictNext continues the line, rounds to the requested decimals and clamps below at 0', () => {
    expect(predictNext([1, 2, 3, 4], { horizon: 3 })).toEqual([5, 6, 7]);
    expect(predictNext([0, 1, 1], { horizon: 2, decimals: 2 })).toEqual([1.67, 2.17]); // 0.5x + 0.1667 → x=3: 1.6667, x=4: 2.1667
    expect(predictNext([10, 7, 4, 1], { horizon: 3 })).toEqual([0, 0, 0]);              // -2, -5, -8 → clamped
    expect(predictNext([50, 80, 99], { horizon: 2, max: 100 })).toEqual([100, 100]);     // capped (score series)
  });

  it('buildForecast: 7 dated days, one rounded field per series, from the LAST 14 rows only', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ count: i < 6 ? 100 : i - 5, totalAmount: (i < 6 ? 100 : i - 5) * 10.5, avgFraudScore: 60, movingAvg: 2 }));
    // last 14 rows: i = 6..19 → count 1..14 exactly (the first six rows are outside the window)
    const dates = ['2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16', '2026-03-17'];
    const forecast = buildForecast(rows, dates, {
      count: { decimals: 0 }, totalAmount: { decimals: 2 }, avgFraudScore: { decimals: 1, max: 100 }, movingAvg: { decimals: 2 },
    }, (row) => row.count > 0);
    expect(forecast.available).toBe(true);
    expect(forecast.method).toBe(FORECAST_METHOD);
    expect(forecast.method).toBe('linear-regression-14d');
    expect(forecast.days.map((d) => d.date)).toEqual(dates);
    expect(forecast.days.map((d) => d.count)).toEqual([15, 16, 17, 18, 19, 20, 21]);
    expect(forecast.days.map((d) => d.totalAmount)).toEqual([157.5, 168, 178.5, 189, 199.5, 210, 220.5]);
    expect(forecast.days.every((d) => d.avgFraudScore === 60 && d.movingAvg === 2)).toBe(true);
    expect(Object.keys(forecast.days[0])).toEqual(['date', 'count', 'totalAmount', 'avgFraudScore', 'movingAvg']);
  });

  it('buildForecast is unavailable (days: []) with fewer than 7 days containing data in the window', () => {
    const sparse = Array.from({ length: 14 }, (_, i) => ({ count: i < 6 ? 3 : 0 })); // 6 days with data
    const none = buildForecast(sparse, ['2026-03-11'], { count: { decimals: 0 } }, (row) => row.count > 0);
    expect(none).toEqual({ available: false, method: 'linear-regression-14d', days: [] });
    const seven = Array.from({ length: 14 }, (_, i) => ({ count: i < 7 ? 3 : 0 }));
    expect(buildForecast(seven, ['2026-03-11'], { count: { decimals: 0 } }, (row) => row.count > 0).available).toBe(true);
    // data older than the 14-day window does not count
    const old = [...Array.from({ length: 10 }, () => ({ count: 5 })), ...Array.from({ length: 14 }, () => ({ count: 0 }))];
    expect(buildForecast(old, ['2026-03-11'], { count: { decimals: 0 } }, (row) => row.count > 0).available).toBe(false);
  });
});

// ── C-04 / C-08 settings + index definitions ────────────────────────────────────────────────────────
describe('C-04 / C-08 opsSettings', () => {
  it('NOTIFICATION_TTL_DAYS: default 90 days, 0 disables, a positive integer overrides, garbage falls back', () => {
    expect(getNotificationTtlSeconds({})).toBe(90 * 86400);
    expect(getNotificationTtlSeconds({ NOTIFICATION_TTL_DAYS: '' })).toBe(90 * 86400);
    expect(getNotificationTtlSeconds({ NOTIFICATION_TTL_DAYS: '30' })).toBe(30 * 86400);
    expect(getNotificationTtlSeconds({ NOTIFICATION_TTL_DAYS: ' 7 ' })).toBe(7 * 86400);
    expect(getNotificationTtlSeconds({ NOTIFICATION_TTL_DAYS: '0' })).toBeNull();
    for (const bad of ['abc', '-5', '1.5', '1e3', '007x', '99999999999']) {
      expect(getNotificationTtlSeconds({ NOTIFICATION_TTL_DAYS: bad })).toBe(90 * 86400);
    }
  });

  it('AUDIT_LOG_TTL_DAYS: no TTL unless a positive integer is set', () => {
    expect(getAuditLogTtlSeconds({})).toBeNull();
    expect(getAuditLogTtlSeconds({ AUDIT_LOG_TTL_DAYS: '' })).toBeNull();
    expect(getAuditLogTtlSeconds({ AUDIT_LOG_TTL_DAYS: '0' })).toBeNull();
    expect(getAuditLogTtlSeconds({ AUDIT_LOG_TTL_DAYS: 'x' })).toBeNull();
    expect(getAuditLogTtlSeconds({ AUDIT_LOG_TTL_DAYS: '365' })).toBe(365 * 86400);
  });

  it('MAX_DEVICES_PER_USER: default 20, positive integers only', () => {
    expect(getMaxDevicesPerUser({})).toBe(20);
    expect(getMaxDevicesPerUser({ MAX_DEVICES_PER_USER: '5' })).toBe(5);
    for (const bad of ['0', '-1', 'abc', '2.5']) expect(getMaxDevicesPerUser({ MAX_DEVICES_PER_USER: bad })).toBe(20);
  });

  it('validateOpsSettings (used by validateEnv) reports every bad value and accepts good / unset ones', () => {
    expect(validateOpsSettings({})).toEqual([]);
    expect(validateOpsSettings({ NOTIFICATION_TTL_DAYS: '0', AUDIT_LOG_TTL_DAYS: '30', MAX_DEVICES_PER_USER: '20' })).toEqual([]);
    const problems = validateOpsSettings({ NOTIFICATION_TTL_DAYS: 'ninety', AUDIT_LOG_TTL_DAYS: '-1', MAX_DEVICES_PER_USER: '0' });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/NOTIFICATION_TTL_DAYS/);
    expect(problems[1]).toMatch(/AUDIT_LOG_TTL_DAYS/);
    expect(problems[2]).toMatch(/MAX_DEVICES_PER_USER/);
  });

  describe('validateEnv wiring', () => {
    const KEYS = ['NODE_ENV', 'MONGODB_URI', 'JWT_SECRET', 'NOTIFICATION_TTL_DAYS', 'AUDIT_LOG_TTL_DAYS', 'MAX_DEVICES_PER_USER'];
    const saved = {};
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
      process.env.NODE_ENV = 'development';
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/finguardai_dev';
      process.env.JWT_SECRET = 'x'.repeat(40);
      for (const k of ['NOTIFICATION_TTL_DAYS', 'AUDIT_LOG_TTL_DAYS', 'MAX_DEVICES_PER_USER']) delete process.env[k];
    });
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    it('fails fast on an invalid value and passes on valid or missing ones', () => {
      expect(() => validateEnv()).not.toThrow();
      process.env.NOTIFICATION_TTL_DAYS = '0';
      process.env.AUDIT_LOG_TTL_DAYS = '400';
      process.env.MAX_DEVICES_PER_USER = '10';
      expect(() => validateEnv()).not.toThrow();
      process.env.NOTIFICATION_TTL_DAYS = 'abc';
      expect(() => validateEnv()).toThrow(/NOTIFICATION_TTL_DAYS/);
      process.env.NOTIFICATION_TTL_DAYS = '90';
      process.env.MAX_DEVICES_PER_USER = '-3';
      expect(() => validateEnv()).toThrow(/MAX_DEVICES_PER_USER/);
    });
  });
});

describe('C-04 index definitions', () => {
  const ttlOf = (model) => model.schema.indexes().filter(([, options]) => options?.expireAfterSeconds !== undefined);

  it('Notification: TTL index on createdAt, 90 days by default; AuditLog: no TTL by default', () => {
    const notificationTtl = ttlOf(NotificationModel);
    expect(notificationTtl).toHaveLength(1);
    expect(notificationTtl[0][0]).toEqual({ createdAt: 1 });
    expect(notificationTtl[0][1].expireAfterSeconds).toBe(90 * 86400);
    expect(ttlOf(AuditLogModel)).toHaveLength(0); // logs are kept forever unless AUDIT_LOG_TTL_DAYS is set
    // the pre-existing audit indexes are unchanged
    expect(AuditLogModel.schema.indexes().map(([fields]) => fields)).toEqual(
      expect.arrayContaining([{ actorId: 1, timestamp: -1 }, { entityType: 1, entityId: 1 }, { timestamp: -1 }])
    );
  });

  // The model reads the environment when it is first imported, so each variant runs in a fresh Node process.
  const indexesIn = (modelFile, env) => JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(`./models/${modelFile}`)}).then((m) => console.log(JSON.stringify(m.default.schema.indexes())))`],
    { cwd: backendDir, env: { ...process.env, ...env }, encoding: 'utf8' }
  ).trim().split('\n').pop());

  it('NOTIFICATION_TTL_DAYS=7 → 7 days; =0 → no TTL index at all', () => {
    const seven = indexesIn('NotificationModel.js', { NOTIFICATION_TTL_DAYS: '7' }).filter(([, o]) => o.expireAfterSeconds !== undefined);
    expect(seven).toEqual([[{ createdAt: 1 }, expect.objectContaining({ expireAfterSeconds: 7 * 86400 })]]);
    const off = indexesIn('NotificationModel.js', { NOTIFICATION_TTL_DAYS: '0' }).filter(([, o]) => o.expireAfterSeconds !== undefined);
    expect(off).toEqual([]);
  });

  it('AUDIT_LOG_TTL_DAYS=30 adds a TTL index on createdAt (the plain timestamp index stays) and the model still loads with its guards', () => {
    const indexes = indexesIn('AuditLogModel.js', { AUDIT_LOG_TTL_DAYS: '30' });
    expect(indexes.filter(([, o]) => o.expireAfterSeconds !== undefined)).toEqual([[{ createdAt: 1 }, expect.objectContaining({ expireAfterSeconds: 30 * 86400 })]]);
    expect(indexes.map(([fields]) => fields)).toContainEqual({ timestamp: -1 });
  });
});

// ── D-02 / R-01 login throttle ──────────────────────────────────────────────────────────────────────
describe('D-02 / R-01 loginThrottle (fake timers)', () => {
  beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-03-10T08:30:00.000Z') }); resetLoginThrottle(); });
  afterEach(() => { jest.useRealTimers(); resetLoginThrottle(); });

  const IP_A = '198.51.100.1';
  const IP_B = '198.51.100.2';
  const attempt = (email, ip, times = 1) => { let last; for (let i = 0; i < times; i += 1) last = reserveLoginAttempt(email, ip); return last; };

  it('thresholds: 5 per e-mail+IP, 30 per e-mail', () => {
    expect(MAX_FAILURES).toBe(5);
    expect(EMAIL_MAX_FAILURES).toBe(30);
    expect(WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('5 attempts from one IP lock that pair for 15 minutes from the LAST one; the 6th is refused; e-mail is normalised', () => {
    attempt('Victim@Example.com', IP_A, 4);
    expect(getLockoutRemainingMs('victim@example.com', IP_A)).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(reserveLoginAttempt('  VICTIM@example.com ', IP_A)).toEqual({ allowed: true }); // the 5th
    expect(getLockoutRemainingMs('victim@example.com', IP_A)).toBe(WINDOW_MS);
    expect(reserveLoginAttempt('victim@example.com', IP_A)).toEqual({ allowed: false, retryAfterMs: WINDOW_MS });
    jest.advanceTimersByTime(5 * 60_000);
    expect(getLockoutRemainingMs('victim@example.com', IP_A)).toBe(10 * 60_000);
    expect(getLockoutRemainingMs('someone-else@example.com', IP_A)).toBe(0);
  });

  it('R-01: a lock from IP A does NOT lock the owner on IP B', () => {
    attempt('owner@example.com', IP_A, 5);
    expect(reserveLoginAttempt('owner@example.com', IP_A).allowed).toBe(false);
    expect(reserveLoginAttempt('owner@example.com', IP_B).allowed).toBe(true);
    expect(getLockoutRemainingMs('owner@example.com', IP_B)).toBe(0);
  });

  it('R-01: the e-mail-only counter locks everyone at 30 attempts, whatever the IPs', () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i += 1) expect(reserveLoginAttempt('target@example.com', `203.0.113.${i}`).allowed).toBe(true);
    const owner = reserveLoginAttempt('target@example.com', '192.0.2.99'); // never seen before
    expect(owner).toEqual({ allowed: false, retryAfterMs: WINDOW_MS });
    jest.advanceTimersByTime(WINDOW_MS);
    expect(reserveLoginAttempt('target@example.com', '192.0.2.99').allowed).toBe(true);
  });

  it('29 attempts spread over many IPs do not lock anybody', () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i += 1) reserveLoginAttempt('quiet@example.com', `203.0.113.${i}`);
    expect(reserveLoginAttempt('quiet@example.com', '192.0.2.99').allowed).toBe(true);
  });

  it('refused attempts are not counted and do not extend the lock; it ends exactly 15 minutes after the last counted one', () => {
    attempt('a@b.co', IP_A, 5);
    jest.advanceTimersByTime(10 * 60_000);
    reserveLoginAttempt('a@b.co', IP_A); // refused
    expect(getLockoutRemainingMs('a@b.co', IP_A)).toBe(5 * 60_000);
    jest.advanceTimersByTime(5 * 60_000 - 1);
    expect(getLockoutRemainingMs('a@b.co', IP_A)).toBe(1);
    jest.advanceTimersByTime(1);
    expect(getLockoutRemainingMs('a@b.co', IP_A)).toBe(0);
    expect(trackedPairKeys() + trackedEmailKeys()).toBe(0); // lazy expiry removed the entries
  });

  it('attempts older than 15 minutes do not count', () => {
    attempt('slow@b.co', IP_A, 3);
    jest.advanceTimersByTime(WINDOW_MS + 1);
    attempt('slow@b.co', IP_A, 4);
    expect(getLockoutRemainingMs('slow@b.co', IP_A)).toBe(0); // 4 fresh attempts only
    attempt('slow@b.co', IP_A);
    expect(getLockoutRemainingMs('slow@b.co', IP_A)).toBeGreaterThan(0);
  });

  it('parallel burst: the attempt is counted at admission, so exactly 5 of 20 simultaneous requests pass', async () => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, async () => {
      const r = reserveLoginAttempt('burst@b.co', IP_A); // what the middleware does before the bcrypt await
      await Promise.resolve();
      return r.allowed;
    }));
    expect(outcomes.filter(Boolean)).toHaveLength(5);
  });

  it('a success clears both counters; release gives one slot back', () => {
    attempt('ok@b.co', IP_A, 4);
    clearLoginFailures('OK@b.co', IP_A);
    attempt('ok@b.co', IP_A, 4);
    expect(getLockoutRemainingMs('ok@b.co', IP_A)).toBe(0);
    releaseLoginAttempt('ok@b.co', IP_A);
    attempt('ok@b.co', IP_A, 1);
    expect(getLockoutRemainingMs('ok@b.co', IP_A)).toBe(0); // 3 + 1 = 4 held attempts
    attempt('ok@b.co', IP_A, 1);
    expect(getLockoutRemainingMs('ok@b.co', IP_A)).toBeGreaterThan(0);
    clearLoginFailures('ok@b.co', IP_A);
    expect(trackedPairKeys() + trackedEmailKeys()).toBe(0);
  });

  it('memory is bounded per counter; expired keys go first, an actively locked key survives while unlocked ones exist', () => {
    expect(MAX_KEYS).toBe(10_000);
    attempt('locked@spray.test', IP_A, 5); // oldest key, locked
    for (let i = 0; i < MAX_KEYS + 50; i += 1) reserveLoginAttempt(`user${i}@spray.test`, IP_A);
    expect(trackedPairKeys()).toBe(MAX_KEYS);
    expect(trackedEmailKeys()).toBe(MAX_KEYS);
    expect(reserveLoginAttempt('locked@spray.test', IP_A).allowed).toBe(false); // still locked, not evicted
    // after the window everything is expired and is cleared first
    jest.advanceTimersByTime(WINDOW_MS + 1);
    reserveLoginAttempt('fresh@spray.test', IP_A);
    expect(trackedPairKeys()).toBeLessThanOrEqual(MAX_KEYS);
    expect(getLockoutRemainingMs('locked@spray.test', IP_A)).toBe(0);
  });

  it('when EVERY key is locked the oldest one is evicted (bounded memory wins)', () => {
    for (let i = 0; i < MAX_KEYS; i += 1) attempt(`all${i}@spray.test`, IP_A, 5);
    expect(trackedPairKeys()).toBe(MAX_KEYS);
    reserveLoginAttempt('newcomer@spray.test', IP_A);
    expect(trackedPairKeys()).toBe(MAX_KEYS);
    expect(getLockoutRemainingMs('all0@spray.test', IP_A)).toBe(0);
    expect(getLockoutRemainingMs('all1@spray.test', IP_A)).toBeGreaterThan(0);
  });

  it('middleware: 429 + Retry-After + generic wording while locked, passes through otherwise', () => {
    const run = (email, ip = IP_A) => {
      const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      const next = jest.fn();
      loginAccountThrottle({ body: { email }, ip }, res, next);
      return { res, next };
    };
    expect(run('free@b.co').next).toHaveBeenCalled();
    expect(run(undefined).next).toHaveBeenCalled(); // validators answer 422
    expect(run(['x']).next).toHaveBeenCalled();
    attempt('locked@b.co', IP_A, 4); // the 5th is the middleware call below
    expect(run('locked@b.co').next).toHaveBeenCalled();
    jest.advanceTimersByTime(30_000);
    const { res, next } = run('LOCKED@b.co');
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe('870');
    expect(res.body).toEqual({ success: false, message: 'Too many failed sign-in attempts. Please try again in 15 minute(s).' });
    expect(res.body.message).not.toMatch(/exist|account|password|user/i);
    expect(run('locked@b.co', IP_B).next).toHaveBeenCalled(); // another address is not affected
  });
});

// ── A-08 scenario plan ──────────────────────────────────────────────────────────────────────────────
describe('A-08 simulation plan', () => {
  it('quotas follow 60/10/10/8/6/6 and always add up to the count', () => {
    expect(SCENARIO_WEIGHTS.reduce((s, [, w]) => s + w, 0)).toBe(100);
    expect(scenarioQuotas(100)).toEqual({ normal: 60, unusualCity: 10, largeAmount: 10, newDevice: 8, burst: 6, highRiskMerchant: 6 });
    expect(scenarioQuotas(30)).toEqual({ normal: 18, unusualCity: 3, largeAmount: 3, newDevice: 2, burst: 2, highRiskMerchant: 2 });
    for (let n = 1; n <= 100; n += 1) {
      expect(Object.values(scenarioQuotas(n)).reduce((s, v) => s + v, 0)).toBe(n);
    }
  });

  const personas = Array.from({ length: 6 }, (_, i) => ({ user: { _id: `u${i + 1}` }, n: i + 1, homeCity: 'Mumbai', homeDevice: `sim-u${i + 1}-home`, paymentMethod: 'UPI', base: 300 + 120 * (i + 1) }));

  it('planRun yields exactly `count` steps with the quota mix, primes every user first, keeps the burst contiguous', () => {
    const plan = planRun(30, personas, new Set(), null, createRng(1));
    expect(plan).toHaveLength(30);
    const tally = plan.reduce((acc, s) => ({ ...acc, [s.scenario]: (acc[s.scenario] ?? 0) + 1 }), {});
    // the burst block borrows up to 4 normals for the same user, but the totals per scenario stay the quotas
    expect(tally).toEqual(scenarioQuotas(30));
    expect(plan.slice(0, 6).map((s) => s.persona.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.slice(0, 6).every((s) => s.scenario === 'normal')).toBe(true);
    const burstAt = plan.findIndex((s) => s.scenario === 'burst');
    expect(plan[burstAt + 1].scenario).toBe('burst');
    const block = plan.slice(burstAt - 4, burstAt + 2);
    expect(new Set(block.map((s) => s.persona.n)).size).toBe(1); // 4 normals + 2 bursts, one user
  });

  it('is deterministic for the same seed and differs for another', () => {
    const names = (seed) => planRun(40, personas, new Set(personas.map((p) => p.user._id)), 'u3', createRng(seed)).map((s) => `${s.scenario}:${s.persona.n}`);
    expect(names(7)).toEqual(names(7));
    expect(names(7)).not.toEqual(names(8));
  });

  it('every payload uses a "sim-" device id and the scenario shape', () => {
    const rng = createRng(3);
    const home = buildPayload({ scenario: 'normal', persona: personas[0], variant: 0 }, rng, 1);
    expect(home.deviceId).toBe('sim-u1-home');
    expect(home.location.city).toBe('Mumbai');
    const nd = buildPayload({ scenario: 'newDevice', persona: personas[0], variant: 0 }, rng, 99);
    expect(nd.deviceId).toMatch(/^sim-u1-nd-/);
    const far = buildPayload({ scenario: 'unusualCity', persona: personas[1], variant: 0 }, rng, 2);
    expect(far.location.city).not.toBe('Mumbai');
    const big = buildPayload({ scenario: 'largeAmount', persona: personas[0], variant: 0 }, rng, 3);
    expect(big.amount).toBeGreaterThan(50000);
    const risky = [0, 1].map((variant) => buildPayload({ scenario: 'highRiskMerchant', persona: personas[0], variant }, rng, 4 + variant));
    expect(['CASINO', 'CRYPTO_EXCHANGE', 'GAMBLING']).toContain(risky[0].merchantCategory);
    expect(risky[0].deviceId).toBe('sim-u1-home');
    expect(risky[1].deviceId).toMatch(/^sim-u1-nd-/); // odd variant: unknown device on top
    for (const p of [home, nd, far, big, ...risky]) expect(p.deviceId.startsWith('sim-')).toBe(true);
  });
});

// ── B-07 band rule ──────────────────────────────────────────────────────────────────────────────────
describe('B-07 riskLevelForScore', () => {
  const bands = { mediumMin: 25, highMin: 50, criticalMin: 75 };
  it('lower bounds are inclusive: LOW < mediumMin <= MEDIUM < highMin <= HIGH < criticalMin <= CRITICAL', () => {
    const at = (s) => riskLevelForScore(s, bands);
    expect([0, 24].map(at)).toEqual(['LOW', 'LOW']);
    expect([25, 49].map(at)).toEqual(['MEDIUM', 'MEDIUM']);
    expect([50, 74].map(at)).toEqual(['HIGH', 'HIGH']);
    expect([75, 100].map(at)).toEqual(['CRITICAL', 'CRITICAL']);
  });

  it('is the rule checkFraud itself applies (every score 0..100 for custom bands)', () => {
    const custom = { mediumMin: 10, highMin: 40, criticalMin: 90 };
    for (const merchant of ['RETAIL', 'CASINO']) {
      const out = checkFraud({
        transaction: { amount: 60000, merchantCategory: merchant, deviceId: 'd', location: { city: 'X' }, timestamp: new Date() },
        thresholds: { scoreThresholds: custom },
      });
      expect(out.riskLevel).toBe(riskLevelForScore(out.fraudScore, custom));
    }
    expect(defaultScoreThresholds()).toEqual(bands);
  });
});

// ── enums / OPS config ──────────────────────────────────────────────────────────────────────────────
describe('R-07 NODE_ENV reporting', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; });

  it('getNodeEnvWarnings: silent for development / test / production, a warning otherwise', () => {
    for (const ok of ['development', 'test', 'production', ' Production ', 'DEVELOPMENT']) expect(getNodeEnvWarnings({ NODE_ENV: ok })).toEqual([]);
    const unset = getNodeEnvWarnings({});
    expect(unset).toHaveLength(1);
    expect(unset[0]).toMatch(/NODE_ENV is not set/);
    expect(unset[0]).toMatch(/NODE_ENV=development/);
    expect(getNodeEnvWarnings({ NODE_ENV: '   ' })[0]).toMatch(/not set/);
    expect(getNodeEnvWarnings({ NODE_ENV: 'staging' })[0]).toMatch(/"staging".*NODE_ENV=development/);
  });

  it('validateEnv prints that warning (never throws for it)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const keep = { u: process.env.MONGODB_URI, j: process.env.JWT_SECRET };
    process.env.NODE_ENV = 'staging';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/finguardai_dev';
    process.env.JWT_SECRET = 'x'.repeat(40);
    try {
      expect(() => validateEnv()).toThrow(/Invalid environment configuration/); // production-like rules still apply
      expect(warn.mock.calls.flat().join('\n')).toMatch(/NODE_ENV is "staging"/);
    } finally {
      warn.mockRestore();
      process.env.MONGODB_URI = keep.u; process.env.JWT_SECRET = keep.j;
    }
  });

  it('describeEnvironment never claims "development" for an unset NODE_ENV', () => {
    delete process.env.NODE_ENV;
    expect(describeEnvironment()).toBe('production-like (NODE_ENV not set)');
    process.env.NODE_ENV = 'staging';
    expect(describeEnvironment()).toBe('production-like (NODE_ENV="staging")');
    for (const mode of ['development', 'test', 'production']) { process.env.NODE_ENV = mode; expect(describeEnvironment()).toBe(mode); }
  });
});

describe('enums, OPS and lint wiring', () => {
  it('new shared enum values exist', () => {
    expect(ALERT_STATUSES).toContain('ACKNOWLEDGED');
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['ALERT_ACKNOWLEDGED', 'SIMULATION_DATA_GENERATED', 'SIMULATION_DATA_CLEARED']));
  });

  it('assertSyncConfig refuses an unset / blank / template MONGODB_URI', () => {
    expect(() => assertSyncConfig({})).toThrow(/MONGODB_URI is not set/);
    expect(() => assertSyncConfig({ MONGODB_URI: '   ' })).toThrow(/MONGODB_URI is not set/);
    expect(() => assertSyncConfig({ MONGODB_URI: 'mongodb+srv://u:<password>@c.mongodb.net/<dbname>' })).toThrow(/placeholder/);
    expect(assertSyncConfig({ MONGODB_URI: 'mongodb://127.0.0.1:27017/finguardai' })).toEqual([]);
    expect(assertSyncConfig({ MONGODB_URI: 'mongodb://127.0.0.1:27017' })[0]).toMatch(/no database name/);
  });

  it('package.json has the db:sync-indexes and lint scripts, and the server hints point at the sync script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:sync-indexes']).toBe('node seed/syncIndexes.js');
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(Object.keys(pkg.devDependencies)).toEqual(expect.arrayContaining(['eslint', '@eslint/js', 'globals']));
    expect(fs.readFileSync(path.join(backendDir, 'config/db.js'), 'utf8')).toMatch(/npm run db:sync-indexes/);
    expect(fs.existsSync(path.join(backendDir, 'eslint.config.js'))).toBe(true);
  });
});
