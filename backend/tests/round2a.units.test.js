// tests/round2a.units.test.js — fix round 2a: pure unit tests (no database)
//   B-01 breakdown · B-06 threshold merge + SystemConfig validation · A-07 performance · H-01 buildPagination · audit action list
import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFraud } from '../services/fraudDetectionService.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import { buildPagination, parsePagination } from '../utils/pagination.js';
import { AUDIT_ACTIONS } from '../utils/enums.js';
import { buildTransactionResponse } from '../services/transactionService.js';

const BASE_THRESHOLDS = {
  amountThreshold: 50000,
  velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
  scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  newDeviceWeight: 20,
  highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'],
};
const SAFE_TXN = {
  amount: 500, merchantCategory: 'RETAIL', merchantName: 'BookStore', deviceId: 'known-device',
  location: { city: 'Mumbai', country: 'IN' }, timestamp: new Date('2026-01-15T11:00:00.000Z'),
};
const BASE_BEHAVIOR = {
  knownDeviceIds: ['known-device'], avgTransactionAmount: 1000, transactionVelocity: { perHour: 1, perDay: 3 },
  usualLocations: ['Mumbai'], usualHours: Array.from({ length: 24 }, (_, i) => i),
};
const run = (o = {}) => checkFraud({ transaction: SAFE_TXN, behaviorProfile: BASE_BEHAVIOR, deviceReputation: null, thresholds: BASE_THRESHOLDS, ...o });

// every rule at (or above) its cap: 20 + 35 + 15 + 50 + 10 + 35 = 165 raw points
const WORST = () => run({
  transaction: { ...SAFE_TXN, amount: 90000, merchantCategory: 'CASINO', deviceId: 'new-dev', location: { city: 'Delhi' }, timestamp: new Date('2026-01-15T22:30:00.000Z') },
  behaviorProfile: { ...BASE_BEHAVIOR, transactionVelocity: { perHour: 9, perDay: 30 }, usualHours: [10, 11, 12] },
  deviceReputation: { reputationScore: 5, isBlacklisted: true },
});

describe('B-01 score breakdown', () => {
  it('lists all six rules in a fixed order, points 0 included, max = the rule cap', () => {
    const { breakdown, rawScore } = run();
    expect(breakdown.map((b) => b.rule)).toEqual(['velocity', 'amount', 'location', 'device', 'time', 'merchant']);
    expect(breakdown.map((b) => b.max)).toEqual([20, 35, 15, 50, 10, 35]);
    expect(breakdown.every((b) => b.points === 0 && typeof b.label === 'string' && b.label.length > 0)).toBe(true);
    expect(Object.keys(breakdown[0]).sort()).toEqual(['label', 'max', 'points', 'rule']);
    expect(rawScore).toBe(0);
  });

  it('points of the rules that fired are reported, the others stay 0', () => {
    const r = run({ transaction: { ...SAFE_TXN, merchantCategory: 'CASINO' } });
    expect(r.breakdown.find((b) => b.rule === 'merchant').points).toBe(35);
    expect(r.breakdown.filter((b) => b.rule !== 'merchant').every((b) => b.points === 0)).toBe(true);
    expect(r.rawScore).toBe(35);
    expect(r.fraudScore).toBe(35);
  });

  it('sum(points) === rawScore and fraudScore === min(100, rawScore), also above the clamp', () => {
    const r = WORST();
    expect(r.breakdown.map((b) => b.points)).toEqual([20, 35, 15, 50, 10, 35]);
    expect(r.breakdown.reduce((s, b) => s + b.points, 0)).toBe(r.rawScore);
    expect(r.rawScore).toBe(165);
    expect(r.fraudScore).toBe(100);
    expect(r.fraudScore).toBe(Math.min(100, r.rawScore));
    for (const b of r.breakdown) expect(b.points).toBeLessThanOrEqual(b.max);
  });

  it('holds for many random inputs: no points above the cap, sum === rawScore, clamp rule', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 300; i += 1) {
      const r = run({
        transaction: {
          ...SAFE_TXN, amount: Math.round(rnd() * 120000) + 1, deviceId: rnd() > 0.5 ? 'known-device' : 'other',
          merchantCategory: rnd() > 0.7 ? 'CASINO' : 'RETAIL', location: { city: rnd() > 0.5 ? 'Mumbai' : 'Pune' },
          timestamp: new Date(Date.UTC(2026, 0, 15, Math.floor(rnd() * 24))),
        },
        behaviorProfile: { ...BASE_BEHAVIOR, usualHours: [9, 10, 11], transactionVelocity: { perHour: Math.floor(rnd() * 9), perDay: Math.floor(rnd() * 30) } },
        deviceReputation: rnd() > 0.5 ? { reputationScore: Math.floor(rnd() * 100), isBlacklisted: rnd() > 0.8 } : null,
      });
      expect(r.breakdown.reduce((s, b) => s + b.points, 0)).toBe(r.rawScore);
      expect(r.fraudScore).toBe(Math.min(100, r.rawScore));
      expect(r.breakdown.every((b) => b.points >= 0 && b.points <= b.max)).toBe(true);
    }
  });
});

describe('B-06 stored thresholds are merged per field', () => {
  const defaults = run({ thresholds: null });
  const hostile = {
    amountThreshold: null,
    newDeviceWeight: Number.NaN,
    velocityLimit: { maxPerHour: null, maxPerDay: 'many' },
    scoreThresholds: { mediumMin: null, highMin: Number.NaN, criticalMin: '75' },
    highRiskMerchants: null,
  };

  it('explicit null / NaN / non-number values fall back to the defaults (same result as no config)', () => {
    const txn = { ...SAFE_TXN, amount: 60000, merchantCategory: 'CASINO' };
    const a = run({ thresholds: hostile, transaction: txn });
    const b = run({ thresholds: null, transaction: txn });
    expect(a).toEqual(b);
    expect(defaults.fraudScore).toBe(0);
  });

  it('a stored maxPerHour: null no longer flags every payment with "limit: null"', () => {
    const r = run({ thresholds: { ...BASE_THRESHOLDS, velocityLimit: { maxPerHour: null, maxPerDay: null } }, behaviorProfile: { ...BASE_BEHAVIOR, transactionVelocity: { perHour: 2, perDay: 4 } } });
    expect(r.reasons.join(' ')).not.toMatch(/null|NaN/);
    expect(r.fraudScore).toBe(0);
  });

  it('valid per-field values are still honoured, and a missing sibling keeps its default', () => {
    const r = run({ thresholds: { velocityLimit: { maxPerHour: 2 }, scoreThresholds: { mediumMin: 10 } }, behaviorProfile: { ...BASE_BEHAVIOR, transactionVelocity: { perHour: 2, perDay: 3 } } });
    expect(r.reasons.join(' ')).toMatch(/limit: 2\)/);
    expect(r.fraudScore).toBe(15);
    expect(r.riskLevel).toBe('MEDIUM'); // 15 >= custom mediumMin 10
    expect(run({ thresholds: { scoreThresholds: { mediumMin: 10 } }, transaction: { ...SAFE_TXN, merchantCategory: 'CASINO' } }).riskLevel).toBe('MEDIUM');
  });

  it('weights, bands and the blacklist behave as before: reputation 10 + blacklisted = 16 + 30 = 46 (MEDIUM, not an automatic BLOCK)', () => {
    const r = run({ deviceReputation: { reputationScore: 10, isBlacklisted: true } });
    expect(r.breakdown.find((b) => b.rule === 'device').points).toBe(46);
    expect(r.fraudScore).toBe(46);
    expect(r.riskLevel).toBe('MEDIUM');
    expect(r.recommendedAction).toBe('OTP');
  });
});

describe('B-06 SystemConfig schema validation', () => {
  const validate = (doc) => new SystemConfigModel(doc).validate();

  it('defaults are valid; a consistent custom config is valid', async () => {
    await expect(validate({})).resolves.toBeUndefined();
    await expect(validate({ scoreThresholds: { mediumMin: 10, highMin: 20, criticalMin: 30 }, velocityLimit: { maxPerHour: 4, maxPerDay: 4 } })).resolves.toBeUndefined();
  });

  it.each([
    [{ mediumMin: 60, highMin: 50, criticalMin: 75 }],
    [{ mediumMin: 25, highMin: 25, criticalMin: 75 }],
    [{ mediumMin: 25, highMin: 80, criticalMin: 75 }],
    [{ mediumMin: 25, highMin: 75, criticalMin: 75 }],
  ])('scoreThresholds %j must satisfy mediumMin < highMin < criticalMin', async (scoreThresholds) => {
    await expect(validate({ scoreThresholds })).rejects.toThrow(/ordering violated/);
  });

  it('maxPerDay can not be lower than maxPerHour; the 1..100 range still applies', async () => {
    await expect(validate({ velocityLimit: { maxPerHour: 10, maxPerDay: 9 } })).rejects.toThrow(/maxPerDay \(9\) must be greater than or equal to maxPerHour \(10\)/);
    await expect(validate({ scoreThresholds: { mediumMin: 0, highMin: 50, criticalMin: 75 } })).rejects.toThrow(/mediumMin must be at least 1/);
    await expect(validate({ scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 101 } })).rejects.toThrow(/at most 100/);
  });
});

describe('A-07 performance', () => {
  it('1000 checkFraud calls average well under 5 ms', () => {
    const input = { transaction: { ...SAFE_TXN, amount: 70000, merchantCategory: 'CASINO' }, behaviorProfile: BASE_BEHAVIOR, deviceReputation: { reputationScore: 40 }, thresholds: BASE_THRESHOLDS };
    for (let i = 0; i < 50; i += 1) checkFraud(input); // warm-up
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) checkFraud(input);
    const averageMs = Number(process.hrtime.bigint() - start) / 1e6 / 1000;
    expect(averageMs).toBeLessThan(5);
  });
});

describe('H-01 buildPagination', () => {
  it('shapes { page, limit, total, pages } with numbers', () => {
    expect(buildPagination(2, 10, 25)).toEqual({ page: 2, limit: 10, total: 25, pages: 3 });
    expect(buildPagination('3', '20', 0)).toEqual({ page: 3, limit: 20, total: 0, pages: 0 });
    expect(buildPagination(1, 50, 50)).toEqual({ page: 1, limit: 50, total: 50, pages: 1 });
  });
  it('matches what parsePagination returns', () => {
    const { page, limit } = parsePagination({ page: '2', limit: '5' }, 10);
    expect(buildPagination(page, limit, 11)).toEqual({ page: 2, limit: 5, total: 11, pages: 3 });
  });
});

describe('buildTransactionResponse', () => {
  it('has exactly the documented keys (plus scoreBreakdown) and plain breakdown objects', () => {
    const txn = {
      _id: 'a1', publicId: 'TXN-2026-00001', amount: 5, merchantName: 'M', merchantCategory: 'GENERAL', paymentMethod: 'UPI',
      fraudScore: 10, riskLevel: 'LOW', reasons: ['r'], recommendedAction: 'APPROVE', estimatedLoss: 0, status: 'APPROVED',
      timestamp: new Date(0), scoreBreakdown: [{ rule: 'amount', label: 'Amount anomaly', points: 10, max: 35, extra: 1 }],
    };
    const out = buildTransactionResponse(txn, { _id: 'al1' });
    expect(Object.keys(out)).toEqual(['id', 'publicId', 'amount', 'merchantName', 'merchantCategory', 'paymentMethod', 'fraudScore', 'riskLevel',
      'reasons', 'recommendedAction', 'estimatedLoss', 'status', 'fraudAlert', 'timestamp', 'scoreBreakdown']);
    expect(out.fraudAlert).toEqual({ id: 'al1' });
    expect(out.scoreBreakdown).toEqual([{ rule: 'amount', label: 'Amount anomaly', points: 10, max: 35 }]);
    expect(buildTransactionResponse({ ...txn, scoreBreakdown: undefined }, null)).toMatchObject({ fraudAlert: null, scoreBreakdown: [] });
  });
});

// ── every createAuditLog(...) action literal must be in AUDIT_ACTIONS (the schema enum would otherwise drop the entry) ──
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = (dir) => fs.readdirSync(path.join(BACKEND, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(BACKEND, dir, f));

/** the text of the 3rd argument of every createAuditLog( … ) call in `source` */
const actionArguments = (source) => {
  const found = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('createAuditLog(', from);
    if (at === -1) break;
    from = at + 1;
    let depth = 0; let quote = null; let arg = 0; let current = ''; const args = [];
    for (let i = at + 'createAuditLog('.length; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) { current += ch; if (ch === quote && source[i - 1] !== '\\') quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) { if (depth === 0) { args.push(current); break; } depth -= 1; }
      if (ch === ',' && depth === 0) { args.push(current); current = ''; arg += 1; if (arg > 2) break; continue; }
      current += ch;
    }
    if (args[2] !== undefined && !source.slice(Math.max(0, at - 20), at).includes('const createAuditLog')) found.push(args[2]);
  }
  return found;
};

describe('audit action enum', () => {
  it('every action passed to createAuditLog is listed in AUDIT_ACTIONS', () => {
    const literals = new Set();
    for (const file of ['routes', 'utils', 'services', 'middleware'].flatMap(sourceFiles)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const arg of actionArguments(source)) {
        const names = arg.match(/'([A-Z_]+)'/g) ?? [];
        // a bare identifier (not a quoted literal) would escape this check: refuse it
        if (names.length === 0 && !/^\s*action\s*$/.test(arg)) throw new Error(`non-literal audit action "${arg.trim()}" in ${path.basename(file)}`);
        names.forEach((n) => literals.add(n.replaceAll("'", '')));
      }
    }
    expect(literals.size).toBeGreaterThan(15);
    for (const action of literals) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('contains the new read-audit and block actions and no duplicates', () => {
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['TRANSACTION_VIEWED', 'DEVICE_VIEWED', 'TRANSACTION_BLOCKED']));
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
