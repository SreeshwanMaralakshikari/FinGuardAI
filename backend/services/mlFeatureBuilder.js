/**
 * @file services/mlFeatureBuilder.js
 * @description Phase 10: builds the 15-feature payload the ML service scores (ml-service/app/features.py
 *   is the contract). Pure: no DB, no network — it reads exactly the objects transactionService already
 *   loads for the rule engine, and derives every flag with the SAME condition the matching rule uses,
 *   so the model and the rules always see the same facts:
 *     isNewCity   ↔ locationCheck      (case-insensitive, needs a non-empty usualLocations)
 *     isNewDevice ↔ deviceCheck        (needs a non-empty knownDeviceIds)
 *     isUnusualHour / hourOfDay ↔ timePatternCheck (hour in APP_TIME_ZONE, Asia/Kolkata)
 *     isHighRiskMerchant ↔ merchantRiskCheck (same normalised match, same admin list)
 *     txnsLastHour / txnsLastDay ↔ velocityCheck (live counts, current payment excluded)
 *     deviceReputationScore = 100 for a device without a record (deviceCheck's default)
 *
 *   The labels / formatted values below are what the frontend shows next to each SHAP bar.
 */
import { getHourInAppZone } from '../config/timeZone.js';
import { normalizeCity, formatRupees } from '../utils/normalize.js';
import { findHighRiskMerchant } from './fraudDetectionService.js';
import { ML_FEATURE_KEYS } from '../utils/enums.js';

/** Every key the service expects — no more, no fewer (it answers 422 otherwise). */
export { ML_FEATURE_KEYS };

const MAX_RATIO = 1_000_000; // the contract's upper bound for both ratio features

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const flag = (condition) => (condition ? 1 : 0);
const ratio = (amount, base) => (base > 0 ? Math.min(MAX_RATIO, amount / base) : 1);

/**
 * @param {object} args
 * @param {{ amount: number, paymentMethod: string, merchantCategory?: string, location?: { city?: string },
 *           deviceId: string, timestamp: Date }} args.transaction
 * @param {object|null} args.behaviorProfile   lean BehaviorProfile (null for a new customer)
 * @param {object|null} args.deviceReputation  lean DeviceReputation (null for a new device)
 * @param {{ perHour: number, perDay: number }} args.velocity  live counts, current payment excluded
 * @param {string[]} args.highRiskMerchants    the EFFECTIVE admin list (resolveThresholds)
 * @returns {Record<string, number|string>}
 */
export const buildMlFeatures = ({ transaction, behaviorProfile, deviceReputation, velocity, highRiskMerchants }) => {
  const profile = behaviorProfile ?? {};
  const amount = transaction.amount;
  const avg = finite(profile.avgTransactionAmount) ?? 0;
  const max = finite(profile.maxTransactionAmount) ?? 0;
  const usualLocations = Array.isArray(profile.usualLocations) ? profile.usualLocations : [];
  const knownDeviceIds = Array.isArray(profile.knownDeviceIds) ? profile.knownDeviceIds : [];
  const usualMethods = Array.isArray(profile.usualPaymentMethods) ? profile.usualPaymentMethods : [];
  const usualHours = Array.isArray(profile.usualHours) ? profile.usualHours : [];

  const cityKey = normalizeCity(transaction.location?.city);
  const knownCity = cityKey && cityKey !== 'unknown';
  const hour = getHourInAppZone(transaction.timestamp);
  const reputation = finite(deviceReputation?.reputationScore) ?? 100;

  return {
    amount,
    amountToAvgRatio: ratio(amount, avg),
    amountToMaxRatio: ratio(amount, max),
    txnsLastHour: velocity.perHour,
    txnsLastDay: velocity.perDay,
    isNewCity: flag(knownCity && usualLocations.length > 0
      && !usualLocations.some((usual) => normalizeCity(usual) === cityKey)),
    isNewDevice: flag(transaction.deviceId && knownDeviceIds.length > 0 && !knownDeviceIds.includes(transaction.deviceId)),
    isNewPaymentMethod: flag(usualMethods.length > 0 && !usualMethods.includes(transaction.paymentMethod)),
    isUnusualHour: flag(usualHours.length > 0 && !usualHours.includes(hour)),
    hourOfDay: hour,
    deviceReputationScore: Math.min(100, Math.max(0, reputation)),
    deviceIsBlacklisted: flag(deviceReputation?.isBlacklisted === true),
    isHighRiskMerchant: flag(findHighRiskMerchant(transaction.merchantCategory, highRiskMerchants) !== undefined),
    // amount ≥ 0.01, so a positive average means at least one trusted payment exists (same test as the amount rule)
    hasProfile: flag(avg > 0),
    paymentMethod: transaction.paymentMethod,
  };
};

// ─── Presentation: label + readable value for each feature (stored with its SHAP value) ────────────
const yesNo = (v) => (v === 1 ? 'Yes' : 'No');
// one decimal, Indian digit grouping for large ratios (543478.26 → "5,43,478.3×"), as in the ML reasons
const times = (v) => `${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;

export const ML_FEATURE_LABELS = Object.freeze({
  amount:                { label: 'Payment amount',                    format: (v) => `₹${formatRupees(v)}` },
  amountToAvgRatio:      { label: 'Amount vs usual average',           format: times },
  amountToMaxRatio:      { label: 'Amount vs largest earlier payment', format: times },
  txnsLastHour:          { label: 'Payments in the last hour',         format: String },
  txnsLastDay:           { label: 'Payments in the last 24 hours',     format: String },
  isNewCity:             { label: 'New city for this customer',        format: yesNo },
  isNewDevice:           { label: 'New device for this customer',      format: yesNo },
  isNewPaymentMethod:    { label: 'New payment method',                format: yesNo },
  isUnusualHour:         { label: 'Unusual hour for this customer',    format: yesNo },
  hourOfDay:             { label: 'Hour of day (IST)',                 format: (v) => `${String(v).padStart(2, '0')}:00` },
  deviceReputationScore: { label: 'Device trust score',                format: (v) => `${Math.round(v)}/100` },
  deviceIsBlacklisted:   { label: 'Device blacklisted',                format: yesNo },
  isHighRiskMerchant:    { label: 'High-risk merchant category',       format: yesNo },
  hasProfile:            { label: 'Has payment history',               format: yesNo },
  paymentMethod:         { label: 'Payment method',                    format: (v) => String(v).replace('_', ' ') },
});

/** Alert type of a feature, for the FraudAlert classification (features with no matching type map to null). */
export const ML_FEATURE_ALERT_TYPES = Object.freeze({
  amount: 'AMOUNT_ANOMALY',
  amountToAvgRatio: 'AMOUNT_ANOMALY',
  amountToMaxRatio: 'AMOUNT_ANOMALY',
  txnsLastHour: 'VELOCITY_BREACH',
  txnsLastDay: 'VELOCITY_BREACH',
  isNewCity: 'LOCATION_DEVIATION',
  isNewDevice: 'NEW_DEVICE',
  deviceReputationScore: 'NEW_DEVICE',
  deviceIsBlacklisted: 'NEW_DEVICE',
  isUnusualHour: 'UNUSUAL_HOUR',
  hourOfDay: 'UNUSUAL_HOUR',
  isHighRiskMerchant: 'HIGH_RISK_MERCHANT',
});
