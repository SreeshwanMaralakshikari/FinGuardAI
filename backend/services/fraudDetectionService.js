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
 *     → { fraudScore, riskLevel, reasons, recommendedAction, estimatedLoss, signals,
 *         breakdown, rawScore }
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
 *   breakdown:          Array<{ rule, label, points, max }>,
 *                                 // B-01: ALL six rules in a fixed order (velocity, amount, location,
 *                                 // device, time, merchant); points 0 included, max = the rule cap
 *   rawScore:           number,   // B-01: sum of the six rule points BEFORE the clamp to 0–100
 * }}
 *
 * Also exported for the Phase 10 ML path (services/scoringService.js), so an ML score is
 * turned into a decision exactly like a rule score:
 *   resolveThresholds(thresholds)                      → effective admin settings (defaults per field)
 *   decisionForScore(fraudScore, amount, bands)        → { riskLevel, recommendedAction, estimatedLoss }
 *   findHighRiskMerchant(merchantCategory, configured) → matched high-risk entry or undefined
 *   hardRuleSignals({ transaction, deviceReputation, thresholds }) → [{ key, type, reason, feature }] for a
 *                              blacklisted device / high-risk merchant / high-value amount (the ML rule floor)
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
const highValueReason = (amount, threshold) =>
  `Transaction amount ₹${formatRupees(amount)} exceeds high-value threshold ₹${formatRupees(threshold)}`;

const amountAnomalyCheck = (transaction, behaviorProfile, thresholds) => {
  const reasons = [];
  let score = 0;

  const amount       = transaction.amount ?? 0;
  const absThreshold = thresholds.amountThreshold ?? DEFAULT_THRESHOLDS.amountThreshold;
  const avgAmount    = behaviorProfile?.avgTransactionAmount ?? 0;

  if (amount > absThreshold) {
    score += 20;
    reasons.push(highValueReason(amount, absThreshold));
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
const BLACKLISTED_DEVICE_REASON = 'Device is blacklisted (reputation score below minimum threshold)';

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
    reasons.push(BLACKLISTED_DEVICE_REASON);
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

// ─── High-risk merchant matching (shared with the Phase 10 ML feature builder) ──
// L-15: both sides normalised (upper-case, spaces/punctuation except "_"
// removed), so "casino", "CASI NO" and a stored "Casino" all match.
// The comparison key also drops "_" so "crypto exchange" matches a configured
// CRYPTO_EXCHANGE (the admin form turns spaces into "_").
const categoryKey = (v) => normalizeCategory(v).replaceAll('_', '');

/**
 * The configured high-risk entry `merchantCategory` matches, or undefined.
 * @param {string|undefined} merchantCategory
 * @param {string[]} configured  effective highRiskMerchants list
 * @returns {string|undefined}
 */
const findHighRiskMerchant = (merchantCategory, configured) => {
  const category = categoryKey(merchantCategory);
  return category ? configured.find((entry) => categoryKey(entry) === category) : undefined;
};

// ─── Rule evaluator 6 — Merchant Risk ────────────────────────────────────────
const merchantRiskCheck = (transaction, thresholds) => {
  const reasons = [];
  let score = 0;

  const configured = thresholds.highRiskMerchants ?? DEFAULT_THRESHOLDS.highRiskMerchants;
  const matched    = findHighRiskMerchant(transaction.merchantCategory, configured);

  if (matched !== undefined) {
    score += 35;
    // Show the configured entry (e.g. CRYPTO_EXCHANGE), not the space-less comparison key.
    reasons.push(`High-risk merchant category detected: ${normalizeCategory(matched)}`);
  }

  return { score: Math.min(score, 35), reasons, type: 'HIGH_RISK_MERCHANT' };
};

// ─── Hard signals (Phase 10 rule floor) ─────────────────────────────────────────
/**
 * The rule findings that are an explicit POLICY, not a statistical hint: a device the system has
 * blacklisted, a merchant category the admin put on the high-risk list, and an amount above the admin's
 * high-value threshold. With the ML model on, services/scoringService.js makes sure a payment with one of
 * them is never rated below MEDIUM when the rules rate it MEDIUM or higher (alert-only floor).
 * Same conditions and the same reason sentences as deviceCheck / merchantRiskCheck / amountAnomalyCheck.
 * `feature` is the ML feature that says the same thing, so its (duplicate) model reason can be dropped.
 * @param {{ transaction: object, deviceReputation?: object|null, thresholds?: object|null }} args
 * @returns {Array<{ key: string, type: string, reason: string, feature: string }>}  empty when none fired
 */
const hardRuleSignals = ({ transaction, deviceReputation = null, thresholds = null }) => {
  const effective = resolveThresholds(thresholds);
  const found = [];
  if (deviceReputation?.isBlacklisted) {
    found.push({ key: 'BLACKLISTED_DEVICE', type: 'NEW_DEVICE', reason: BLACKLISTED_DEVICE_REASON, feature: 'deviceIsBlacklisted' });
  }
  const merchant = merchantRiskCheck(transaction, effective);
  if (merchant.score > 0) {
    found.push({ key: 'HIGH_RISK_MERCHANT', type: 'HIGH_RISK_MERCHANT', reason: merchant.reasons[0], feature: 'isHighRiskMerchant' });
  }
  const amount = transaction.amount ?? 0;
  if (amount > effective.amountThreshold) {
    found.push({ key: 'HIGH_VALUE_AMOUNT', type: 'AMOUNT_ANOMALY', reason: highValueReason(amount, effective.amountThreshold), feature: 'amount' });
  }
  return found;
};

// ─── Rule catalogue for the score breakdown (B-01) — `max` mirrors the Math.min cap of each evaluator ─
const RULES = Object.freeze([
  { rule: 'velocity', label: 'Transaction velocity',   max: 20 },
  { rule: 'amount',   label: 'Amount anomaly',         max: 35 },
  { rule: 'location', label: 'Unusual location',       max: 15 },
  { rule: 'device',   label: 'Device risk',            max: 50 },
  { rule: 'time',     label: 'Unusual time of day',    max: 10 },
  { rule: 'merchant', label: 'High-risk merchant',     max: 35 },
]);

// ─── Input normalisation (AUD-18) ─────────────────────────────────────────────
// The merge below uses object spread. Spreading a hydrated Mongoose document
// copies its internals ({ $__, _doc, $isNew }), not its fields, so admin
// thresholds were silently replaced by DEFAULT_THRESHOLDS. Callers should pass
// lean objects (CustomerAPI does); this duck-typed guard keeps the service
// correct even if one does not — without importing Mongoose (D-P5-07).
const toPlain = (value) =>
  value && typeof value.toObject === 'function' ? value.toObject() : value;

/** A usable number, or undefined: null, NaN, Infinity and non-numbers all fall back to the default (B-06). */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * The thresholds the engine actually uses: SystemConfig values merged with the defaults PER FIELD.
 * Shared by checkFraud and the Phase 10 ML path, so both read the admin settings identically.
 * @param {object|null} thresholds  SystemConfig (lean or hydrated) or null on an unseeded DB
 */
const resolveThresholds = (thresholds) => {
  // Safely handle null thresholds — SystemConfigModel.findOne() returns null
  // when the DB is not yet seeded.  JS default parameters only fire for
  // undefined, not null, so we must guard here explicitly.  (C-P5-02)
  const safeThresholds = toPlain(thresholds) ?? {};

  // Merge caller-supplied thresholds with defaults PER FIELD (B-06). `??` (not spread) so an
  // explicit null / NaN / non-number stored in SystemConfig falls back to the default instead of
  // overriding it (a stored maxPerHour: null used to flag every payment with "limit: null").
  return {
    ...DEFAULT_THRESHOLDS,
    ...safeThresholds,
    amountThreshold:  num(safeThresholds.amountThreshold)  ?? DEFAULT_THRESHOLDS.amountThreshold,
    newDeviceWeight:  num(safeThresholds.newDeviceWeight)  ?? DEFAULT_THRESHOLDS.newDeviceWeight,
    scoreThresholds: {
      mediumMin:   num(safeThresholds.scoreThresholds?.mediumMin)   ?? DEFAULT_THRESHOLDS.scoreThresholds.mediumMin,
      highMin:     num(safeThresholds.scoreThresholds?.highMin)     ?? DEFAULT_THRESHOLDS.scoreThresholds.highMin,
      criticalMin: num(safeThresholds.scoreThresholds?.criticalMin) ?? DEFAULT_THRESHOLDS.scoreThresholds.criticalMin,
    },
    velocityLimit: {
      maxPerHour: num(safeThresholds.velocityLimit?.maxPerHour) ?? DEFAULT_THRESHOLDS.velocityLimit.maxPerHour,
      maxPerDay:  num(safeThresholds.velocityLimit?.maxPerDay)  ?? DEFAULT_THRESHOLDS.velocityLimit.maxPerDay,
    },
    highRiskMerchants: Array.isArray(safeThresholds.highRiskMerchants)
      ? safeThresholds.highRiskMerchants
      : DEFAULT_THRESHOLDS.highRiskMerchants,
  };
};

// ─── Score → band (shared with the B-07 what-if preview so both always agree) ──────────────────
/**
 * LOW < mediumMin <= MEDIUM < highMin <= HIGH < criticalMin <= CRITICAL (lower bounds are inclusive).
 * @param {number} fraudScore
 * @param {{ mediumMin: number, highMin: number, criticalMin: number }} scoreThresholds
 * @returns {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'}
 */
const riskLevelForScore = (fraudScore, { mediumMin, highMin, criticalMin }) => {
  if (fraudScore >= criticalMin) return 'CRITICAL';
  if (fraudScore >= highMin)     return 'HIGH';
  if (fraudScore >= mediumMin)   return 'MEDIUM';
  return 'LOW';
};

/** The built-in bands used when SystemConfig holds none (a copy, so callers cannot mutate the defaults). */
const defaultScoreThresholds = () => ({ ...DEFAULT_THRESHOLDS.scoreThresholds });

// MEDIUM → 'OTP' is a label only: no OTP step exists, so CustomerAPI approves
// the payment, raises an alert and keeps it OUT of the trusted baseline (L-01).
const ACTION_MAP = Object.freeze({
  LOW:      'APPROVE',
  MEDIUM:   'OTP',
  HIGH:     'HOLD',
  CRITICAL: 'BLOCK',
});

const LOSS_MULTIPLIER = Object.freeze({
  LOW:      0,
  MEDIUM:   0.3,
  HIGH:     0.7,
  CRITICAL: 1.0,
});

/**
 * Risk level, recommended action and estimated loss for a 0–100 score. Used by checkFraud and by the
 * Phase 10 ML path, so a score means the same thing whichever engine produced it.
 * @param {number} fraudScore
 * @param {number} amount
 * @param {{ mediumMin: number, highMin: number, criticalMin: number }} scoreThresholds  effective bands
 */
const decisionForScore = (fraudScore, amount, scoreThresholds) => {
  const riskLevel = riskLevelForScore(fraudScore, scoreThresholds);
  return {
    riskLevel,
    recommendedAction: ACTION_MAP[riskLevel],
    estimatedLoss: Math.round((amount ?? 0) * LOSS_MULTIPLIER[riskLevel]),
  };
};

// ─── Main exported function ───────────────────────────────────────────────────
const checkFraud = ({
  transaction,
  behaviorProfile   = null,
  deviceReputation  = null,
  thresholds        = null,   // null mirrors findOne() return for unseeded DBs (C-P5-02)
}) => {
  const effectiveThresholds = resolveThresholds(thresholds);

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

  // B-01: per-rule explanation. Fixed order, all six rules, 0 points included;
  // `max` is the cap each evaluator applies, so sum(points) === rawScore.
  const breakdown = RULES.map(({ rule, label, max }, i) => ({
    rule,
    label,
    points: [velocity, amount, location, device, time, merchant][i].score,
    max,
  }));

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

  // Derive risk level, action and estimated loss from the score (shared with the ML path)
  const { riskLevel, recommendedAction, estimatedLoss } =
    decisionForScore(fraudScore, transaction.amount, effectiveThresholds.scoreThresholds);

  return {
    fraudScore,
    riskLevel,
    reasons,
    recommendedAction,
    estimatedLoss,
    signals,
    breakdown,
    rawScore,
  };
};

export {
  checkFraud,
  riskLevelForScore,
  defaultScoreThresholds,
  resolveThresholds,
  decisionForScore,
  findHighRiskMerchant,
  hardRuleSignals,
};
