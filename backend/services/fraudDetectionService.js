/**
 * fraudDetectionService.js
 *
 * Pure fraud-detection engine for FinGuardAI.
 *
 * Purpose:
 *   Evaluates a transaction against six independent rule evaluators and
 *   aggregates their scores into a single fraudScore (0–100).  The score
 *   is then mapped to a riskLevel using systemConfig score thresholds, and
 *   a recommendedAction and estimatedLoss are derived from the riskLevel.
 *
 *   This module is intentionally side-effect-free (D-P5-07):
 *     • No DB writes
 *     • No socket emits
 *     • No imports of NotificationModel, AuditLogModel, or any Mongoose model
 *
 * Six internal rule evaluators (not exported):
 *   1. velocityCheck       — transaction velocity vs configured limits  (≤ 20 pts)
 *   2. amountAnomalyCheck  — absolute & relative amount anomaly         (≤ 35 pts)
 *   3. locationCheck       — new / unusual city detection               (≤ 15 pts)
 *   4. deviceCheck         — unknown device + reputation score          (≤ 50 pts)
 *   5. timePatternCheck    — unusual hour of day                        (≤ 10 pts)
 *   6. merchantRiskCheck   — high-risk merchant category                (≤ 35 pts)
 *
 * Exported function:
 *   checkFraud({ transaction, behaviorProfile, deviceReputation, thresholds })
 *     → { fraudScore, riskLevel, reasons, recommendedAction, estimatedLoss, signals }
 *
 * @param {Object} opts
 * @param {Object} opts.transaction      TransactionModel document (plain object or lean)
 * @param {Object} [opts.behaviorProfile]  BehaviorProfileModel document (null for new users)
 * @param {Object} [opts.deviceReputation] DeviceReputationModel document (null for new devices)
 * @param {Object} [opts.thresholds]       Thresholds from SystemConfigModel (null when DB is unseeded)
 *
 * @returns {{\
 *   fraudScore:         number,   // 0–100
 *   riskLevel:          string,   // 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
 *   reasons:            string[], // human-readable explanation strings
 *   recommendedAction:  string,   // 'APPROVE' | 'OTP' | 'HOLD' | 'BLOCK'
 *   estimatedLoss:      number,   // monetary value (same currency unit as amount)
 *   signals:            string[], // distinct FraudAlert alertType of every rule that fired
 *                                 // (AMOUNT_ANOMALY, VELOCITY_BREACH, …) — lets callers classify
 *                                 // an alert without parsing the reason text (L-15)
 * }}
 */

import { getHourInAppZone } from '../config/timeZone.js';
import { normalizeCategory, normalizeCity, formatRupees } from '../utils/normalize.js';

// ─── Default thresholds (fallback when SystemConfig is not yet seeded) ────────
const DEFAULT_THRESHOLDS = {
  scoreThresholds: {
    mediumMin:   25,
    highMin:     50,
    criticalMin: 75,
  },
  amountThreshold: 50_000,       // absolute high-value flag
  velocityLimit: {
    maxPerHour: 5,
    maxPerDay:  20,
  },
  newDeviceWeight:   20,         // base penalty for an unrecognised device fingerprint
  highRiskMerchants: [
    'CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING',
  ],
};

// ─── Rule evaluator 1 — Velocity ─────────────────────────────────────────────
const velocityCheck = (transaction, behaviorProfile, thresholds) => {
  const reasons = [];
  let score = 0;

  const velocity = behaviorProfile?.transactionVelocity ?? { perHour: 0, perDay: 0 };
  const limits   = thresholds.velocityLimit ?? DEFAULT_THRESHOLDS.velocityLimit;

  // NOTE (C-P5-01): >= is correct here, not >.
  // calcBehaviorProfile is fetched BEFORE the current transaction is saved, so
  // velocity.perHour reflects only prior transactions.  When the 6th transaction
  // arrives against a limit of 5, velocity.perHour === 5.  Using > would miss
  // this transaction entirely; >= correctly flags it as exceeding the limit.
  if (velocity.perHour >= limits.maxPerHour) {
    score += 15;
    reasons.push(
      `High hourly velocity: ${velocity.perHour} transactions in the last hour (limit: ${limits.maxPerHour})`
    );
  }

  if (velocity.perDay >= limits.maxPerDay) {
    score += 10;
    reasons.push(
      `High daily velocity: ${velocity.perDay} transactions in the last 24 hours (limit: ${limits.maxPerDay})`
    );
  }

  return { score: Math.min(score, 20), reasons, type: 'VELOCITY_BREACH' };
};

// ─── Rule evaluator 2 — Amount Anomaly ───────────────────────────────────────
const amountAnomalyCheck = (transaction, behaviorProfile, thresholds) => {
  const reasons = [];
  let score = 0;

  const amount       = transaction.amount ?? 0;
  const absThreshold = thresholds.amountThreshold ?? DEFAULT_THRESHOLDS.amountThreshold;
  const avgAmount    = behaviorProfile?.avgTransactionAmount ?? 0;

  if (amount > absThreshold) {
    score += 20;
    reasons.push(
      `Transaction amount ₹${formatRupees(amount)} exceeds high-value threshold ₹${formatRupees(absThreshold)}`
    );
  }

  if (avgAmount > 0 && amount > avgAmount * 3) {
    score += 15;
    reasons.push(
      `Amount ₹${formatRupees(amount)} is ${(amount / avgAmount).toFixed(1)}× the user's average ₹${formatRupees(avgAmount)}`
    );
  }

  return { score: Math.min(score, 35), reasons, type: 'AMOUNT_ANOMALY' };
};

// ─── Rule evaluator 3 — Location ─────────────────────────────────────────────
const locationCheck = (transaction, behaviorProfile) => {
  const reasons = [];
  let score = 0;

  const city           = transaction.location?.city;
  const usualLocations = behaviorProfile?.usualLocations ?? [];

  // L-15: case/whitespace-insensitive on BOTH sides ("mumbai" === "Mumbai");
  // the stored and displayed spelling is untouched.
  const cityKey = normalizeCity(city);
  if (cityKey && cityKey !== 'unknown' && usualLocations.length > 0) {
    if (!usualLocations.some((usual) => normalizeCity(usual) === cityKey)) {
      score += 15;
      reasons.push(
        `Transaction from unusual city: ${city} (usual locations: ${usualLocations.join(', ')})`
      );
    }
  }

  return { score: Math.min(score, 15), reasons, type: 'LOCATION_DEVIATION' };
};

// ─── Rule evaluator 4 — Device ───────────────────────────────────────────────
const deviceCheck = (transaction, behaviorProfile, deviceReputation, thresholds) => {
  const reasons = [];
  let score = 0;

  const deviceId        = transaction.deviceId;
  const knownDeviceIds  = behaviorProfile?.knownDeviceIds ?? [];
  const newDeviceWeight = thresholds.newDeviceWeight ?? DEFAULT_THRESHOLDS.newDeviceWeight;

  if (deviceId && knownDeviceIds.length > 0 && !knownDeviceIds.includes(deviceId)) {
    score += newDeviceWeight;
    reasons.push(`Transaction from unrecognised device (fingerprint: ${deviceId})`);
  }

  const repScore = deviceReputation?.reputationScore ?? 100;
  if (repScore < 50) {
    const penalty = Math.round(((50 - repScore) / 50) * 20);
    score += penalty;
    reasons.push(`Low device reputation score: ${repScore}/100`);
  }

  if (deviceReputation?.isBlacklisted) {
    score += 30;
    reasons.push('Device is blacklisted (reputation score below minimum threshold)');
  }

  return { score: Math.min(score, 50), reasons, type: 'NEW_DEVICE' };
};

// ─── Rule evaluator 5 — Time Pattern ─────────────────────────────────────────
const timePatternCheck = (transaction, behaviorProfile) => {
  const reasons = [];
  let score = 0;

  const usualHours = behaviorProfile?.usualHours ?? [];

  if (usualHours.length > 0) {
    const hour = getHourInAppZone(transaction.timestamp); // N-11: business time zone, not the host's
    if (!usualHours.includes(hour)) {
      score += 10;
      reasons.push(
        `Transaction at unusual hour: ${hour}:00 (usual hours: ${usualHours.join(', ')})`
      );
    }
  }

  return { score: Math.min(score, 10), reasons, type: 'UNUSUAL_HOUR' };
};

// ─── Rule evaluator 6 — Merchant Risk ────────────────────────────────────────
const merchantRiskCheck = (transaction, thresholds) => {
  const reasons = [];
  let score = 0;

  // L-15: both sides normalised (upper-case, spaces/punctuation except "_"
  // removed), so "casino", "CASI NO" and a stored "Casino" all match.
  // The comparison key also drops "_" so "crypto exchange" matches a configured
  // CRYPTO_EXCHANGE (the admin form turns spaces into "_").
  const categoryKey  = (v) => normalizeCategory(v).replaceAll('_', '');
  const category     = categoryKey(transaction.merchantCategory);
  const configured   = thresholds.highRiskMerchants ?? DEFAULT_THRESHOLDS.highRiskMerchants;
  const matched      = category ? configured.find((entry) => categoryKey(entry) === category) : undefined;

  if (matched !== undefined) {
    score += 35;
    // Show the configured entry (e.g. CRYPTO_EXCHANGE), not the space-less comparison key.
    reasons.push(`High-risk merchant category detected: ${normalizeCategory(matched)}`);
  }

  return { score: Math.min(score, 35), reasons, type: 'HIGH_RISK_MERCHANT' };
};

// ─── Input normalisation (AUD-18) ─────────────────────────────────────────────
// The merge below uses object spread. Spreading a hydrated Mongoose document
// copies its internals ({ $__, _doc, $isNew }), not its fields, so admin
// thresholds were silently replaced by DEFAULT_THRESHOLDS. Callers should pass
// lean objects (CustomerAPI does); this duck-typed guard keeps the service
// correct even if one does not — without importing Mongoose (D-P5-07).
const toPlain = (value) =>
  value && typeof value.toObject === 'function' ? value.toObject() : value;

// ─── Main exported function ───────────────────────────────────────────────────
const checkFraud = ({
  transaction,
  behaviorProfile   = null,
  deviceReputation  = null,
  thresholds        = null,   // null mirrors findOne() return for unseeded DBs (C-P5-02)
}) => {
  // Safely handle null thresholds — SystemConfigModel.findOne() returns null
  // when the DB is not yet seeded.  JS default parameters only fire for
  // undefined, not null, so we must guard here explicitly.  (C-P5-02)
  const safeThresholds = toPlain(thresholds) ?? {};

  // Merge caller-supplied thresholds with defaults (shallow, nested-safe)
  const effectiveThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...safeThresholds,
    scoreThresholds: {
      ...DEFAULT_THRESHOLDS.scoreThresholds,
      ...(safeThresholds.scoreThresholds ?? {}),
    },
    velocityLimit: {
      ...DEFAULT_THRESHOLDS.velocityLimit,
      ...(safeThresholds.velocityLimit ?? {}),
    },
    highRiskMerchants:
      safeThresholds.highRiskMerchants ?? DEFAULT_THRESHOLDS.highRiskMerchants,
  };

  // Run all six evaluators
  const velocity = velocityCheck(transaction, behaviorProfile, effectiveThresholds);
  const amount   = amountAnomalyCheck(transaction, behaviorProfile, effectiveThresholds);
  const location = locationCheck(transaction, behaviorProfile);
  const device   = deviceCheck(transaction, behaviorProfile, deviceReputation, effectiveThresholds);
  const time     = timePatternCheck(transaction, behaviorProfile);
  const merchant = merchantRiskCheck(transaction, effectiveThresholds);

  // Aggregate
  const rawScore   = velocity.score + amount.score + location.score +
                     device.score   + time.score   + merchant.score;
  const fraudScore = Math.min(100, Math.max(0, rawScore));

  const reasons = [
    ...velocity.reasons,
    ...amount.reasons,
    ...location.reasons,
    ...device.reasons,
    ...time.reasons,
    ...merchant.reasons,
  ];

  // Which rules fired (alert classification without parsing reason text)
  const signals = [velocity, amount, location, device, time, merchant]
    .filter((rule) => rule.reasons.length > 0)
    .map((rule) => rule.type);

  // Derive risk level from systemConfig score thresholds
  const { mediumMin, highMin, criticalMin } = effectiveThresholds.scoreThresholds;
  let riskLevel;
  if      (fraudScore >= criticalMin) riskLevel = 'CRITICAL';
  else if (fraudScore >= highMin)     riskLevel = 'HIGH';
  else if (fraudScore >= mediumMin)   riskLevel = 'MEDIUM';
  else                                riskLevel = 'LOW';

  // MEDIUM → 'OTP' is a label only: no OTP step exists, so CustomerAPI approves
  // the payment, raises an alert and keeps it OUT of the trusted baseline (L-01).
  const ACTION_MAP = {
    LOW:      'APPROVE',
    MEDIUM:   'OTP',
    HIGH:     'HOLD',
    CRITICAL: 'BLOCK',
  };

  const LOSS_MULTIPLIER = {
    LOW:      0,
    MEDIUM:   0.3,
    HIGH:     0.7,
    CRITICAL: 1.0,
  };

  const txnAmount     = transaction.amount ?? 0;
  const estimatedLoss = Math.round(txnAmount * LOSS_MULTIPLIER[riskLevel]);

  return {
    fraudScore,
    riskLevel,
    reasons,
    recommendedAction: ACTION_MAP[riskLevel],
    estimatedLoss,
    signals,
  };
};

export { checkFraud };
export default checkFraud;
