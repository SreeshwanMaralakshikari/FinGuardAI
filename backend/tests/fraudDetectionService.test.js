// tests/fraudDetectionService.test.js — pure unit tests (no database; D-P5-07 zero side effects)
import { describe, it, expect } from '@jest/globals';
import { checkFraud } from '../services/fraudDetectionService.js';
import { getHourInAppZone } from '../config/timeZone.js';

const BASE_THRESHOLDS = {
  amountThreshold: 50000,
  velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
  scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  newDeviceWeight: 20,
  highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'],
};

const SAFE_TXN = {
  amount: 500,
  merchantCategory: 'RETAIL',
  merchantName: 'BookStore',
  deviceId: 'known-device',
  location: { city: 'Mumbai', country: 'IN' },
  timestamp: new Date('2026-01-15T11:00:00.000Z'),
};

const BASE_BEHAVIOR = {
  knownDeviceIds: ['known-device'],
  avgTransactionAmount: 1000,
  transactionVelocity: { perHour: 1, perDay: 3 },
  usualLocations: ['Mumbai'],
  usualHours: Array.from({ length: 24 }, (_, i) => i), // every hour usual → time rule never fires
};

const run = (o = {}) => checkFraud({ transaction: SAFE_TXN, behaviorProfile: BASE_BEHAVIOR, deviceReputation: null, thresholds: BASE_THRESHOLDS, ...o });

describe('checkFraud — result shape', () => {
  it('returns { fraudScore, riskLevel, reasons[], recommendedAction, estimatedLoss, signals[] }', () => {
    const r = run();
    expect(r).toEqual({ fraudScore: 0, riskLevel: 'LOW', reasons: [], recommendedAction: 'APPROVE', estimatedLoss: 0, signals: [] });
  });
});

describe('rule evaluators', () => {
  it('merchantRiskCheck: CASINO = 35 → MEDIUM / OTP, 30% estimated loss', () => {
    const r = run({ transaction: { ...SAFE_TXN, merchantCategory: 'casino' } });
    expect(r.fraudScore).toBe(35);
    expect(r.riskLevel).toBe('MEDIUM');
    expect(r.recommendedAction).toBe('OTP');
    expect(r.estimatedLoss).toBe(150);
  });

  it('amountAnomalyCheck: > threshold (20) + > 3× average (15)', () => {
    const r = run({ transaction: { ...SAFE_TXN, amount: 60000 } });
    expect(r.fraudScore).toBe(35);
    expect(r.reasons.join(' ')).toMatch(/threshold/);
    expect(r.reasons.join(' ')).toMatch(/× the user's average ₹1,000/); // N-29: it is an all-time mean, not a rolling window
    expect(r.signals).toEqual(['AMOUNT_ANOMALY']); // both amount reasons are ONE rule
  });

  it('deviceCheck: unknown device adds newDeviceWeight (20)', () => {
    expect(run({ transaction: { ...SAFE_TXN, deviceId: 'brand-new' } }).fraudScore).toBe(20);
  });

  it('deviceCheck: low reputation and blacklist add points (capped at 50)', () => {
    const r = run({ deviceReputation: { reputationScore: 0, isBlacklisted: true } });
    expect(r.fraudScore).toBe(50);
    expect(r.riskLevel).toBe('HIGH');
  });

  it('locationCheck: unusual city adds 15', () => {
    const r = run({ transaction: { ...SAFE_TXN, location: { city: 'Delhi' } } });
    expect(r.fraudScore).toBe(15);
    expect(r.reasons[0]).toMatch(/unusual city/);
  });

  it('timePatternCheck: hour outside usualHours adds 10', () => {
    const hour = getHourInAppZone(SAFE_TXN.timestamp);
    expect(hour).toBe(16); // 11:00 UTC = 16:30 IST, whatever TZ the machine runs in (N-11)
    const r = run({ behaviorProfile: { ...BASE_BEHAVIOR, usualHours: [(hour + 12) % 24] } });
    expect(r.fraudScore).toBe(10);
    expect(r.reasons[0]).toMatch(/unusual hour: 16:00/);
  });
});

describe('C-P5-01 — velocityCheck uses >=', () => {
  it('flags when perHour equals the limit (5 >= 5)', () => {
    const r = run({ behaviorProfile: { ...BASE_BEHAVIOR, transactionVelocity: { perHour: 5, perDay: 5 } } });
    expect(r.reasons.some((x) => /hourly velocity/.test(x))).toBe(true);
  });
  it('does not flag below the limit (4 < 5)', () => {
    const r = run({ behaviorProfile: { ...BASE_BEHAVIOR, transactionVelocity: { perHour: 4, perDay: 4 } } });
    expect(r.reasons.filter((x) => /velocity/.test(x))).toHaveLength(0);
  });
});

describe('C-P5-02 — null thresholds (unseeded DB) fall back to defaults', () => {
  it('does not throw and still scores', () => {
    expect(() => run({ thresholds: null, behaviorProfile: null })).not.toThrow();
    expect(run({ thresholds: null, behaviorProfile: null }).riskLevel).toBe('LOW');
    expect(run({ thresholds: null, transaction: { ...SAFE_TXN, merchantCategory: 'GAMBLING' } }).fraudScore).toBe(35);
  });
});

describe('risk bands', () => {
  it('CRITICAL: new device + high amount + CASINO → BLOCK, 100% estimated loss', () => {
    const r = run({ transaction: { ...SAFE_TXN, amount: 60000, merchantCategory: 'CASINO', deviceId: 'brand-new' } });
    expect(r.fraudScore).toBe(90);
    expect(r.riskLevel).toBe('CRITICAL');
    expect(r.recommendedAction).toBe('BLOCK');
    expect(r.estimatedLoss).toBe(60000);
  });

  it('respects custom score thresholds from SystemConfig', () => {
    const r = run({ transaction: { ...SAFE_TXN, merchantCategory: 'CASINO' }, thresholds: { ...BASE_THRESHOLDS, scoreThresholds: { mediumMin: 10, highMin: 30, criticalMin: 60 } } });
    expect(r.riskLevel).toBe('HIGH');
  });
});
