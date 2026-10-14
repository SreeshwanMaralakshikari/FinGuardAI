/**
 * @file utils/enums.js
 * @description H-07: the status / risk-level / role lists in ONE place. Models,
 *   validators and routes import these instead of repeating string literals,
 *   so a list can never drift between the schema and the API.
 *   No imports: safe for any layer.
 */
export const ROLES = Object.freeze(['CUSTOMER', 'ANALYST', 'ADMIN']);
export const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
/** Risk levels an analyst may see (MEDIUM never enters the analyst queue, AUD-38). */
export const FLAGGED_RISK_LEVELS = Object.freeze(['HIGH', 'CRITICAL']);
/** Risk levels that create a FraudAlert. */
export const ALERT_RISK_LEVELS = Object.freeze(['MEDIUM', 'HIGH', 'CRITICAL']);
export const PAYMENT_METHODS = Object.freeze(['UPI', 'CARD', 'NET_BANKING', 'WALLET']);
export const TRANSACTION_STATUSES = Object.freeze(['APPROVED', 'HELD', 'BLOCKED']);
/** F-02: ACKNOWLEDGED = the customer confirmed a MEDIUM alert themselves. It is never "open" (not counted as needing action). */
export const ALERT_STATUSES = Object.freeze(['OPEN', 'REVIEWED', 'DISMISSED', 'ACKNOWLEDGED']);
export const CASE_STATUSES = Object.freeze(['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED']);
/** Phase 10: which engine scored a payment. */
export const SCORING_ENGINES = Object.freeze(['RULES', 'ML']);
/** Phase 10: the 15 inputs of the ML service, in contract order (ml-service/app/features.py). */
export const ML_FEATURE_KEYS = Object.freeze([
  'amount', 'amountToAvgRatio', 'amountToMaxRatio', 'txnsLastHour', 'txnsLastDay',
  'isNewCity', 'isNewDevice', 'isNewPaymentMethod', 'isUnusualHour', 'hourOfDay',
  'deviceReputationScore', 'deviceIsBlacklisted', 'isHighRiskMerchant', 'hasProfile', 'paymentMethod',
]);
/** Phase 10: why the rules scored a payment although ML was enabled (services/mlClient.js). */
export const ML_FALLBACK_REASONS = Object.freeze([
  'TIMEOUT', 'UNAVAILABLE', 'AUTH', 'CONTRACT', 'INVALID_RESPONSE', 'COOLDOWN', 'ERROR',
]);
/** Phase 10: alert types an ML reason can map to (FraudAlert.alertType without COMPOSITE). */
export const ML_SIGNAL_TYPES = Object.freeze([
  'AMOUNT_ANOMALY', 'VELOCITY_BREACH', 'LOCATION_DEVIATION', 'NEW_DEVICE', 'UNUSUAL_HOUR', 'HIGH_RISK_MERCHANT',
]);
/**
 * Every action createAuditLog may write (A-09). The AuditLog schema validates against this list, so a new
 * action MUST be added here (a test scans the source for createAuditLog calls and fails on a missing one).
 */
export const AUDIT_ACTIONS = Object.freeze([
  'USER_REGISTERED', 'USER_LOGIN', 'USER_LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGED', 'PROFILE_UPDATED',
  'USER_ACTIVATED', 'USER_DEACTIVATED',
  'TRANSACTION_SUBMITTED', 'FRAUD_ALERT_CREATED', 'FRAUD_ALERT_STATUS_CHANGED',
  'TRANSACTION_RELEASED', 'TRANSACTION_BLOCKED',
  'CASE_CREATED', 'CASE_ASSIGNED', 'CASE_STATUS_CHANGED', 'CASE_NOTE_ADDED',
  'THRESHOLDS_UPDATED', 'SIMULATION_STARTED', 'SIMULATION_STOPPED',
  'TRANSACTION_VIEWED', 'DEVICE_VIEWED',
  'ALERT_ACKNOWLEDGED', 'SIMULATION_DATA_GENERATED', 'SIMULATION_DATA_CLEARED',
]);
