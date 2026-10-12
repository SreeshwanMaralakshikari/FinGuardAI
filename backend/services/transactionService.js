/**
 * @file services/transactionService.js
 * @description A-09: the submit-transaction orchestration, moved out of routes/CustomerAPI.js.
 *   The route only validates the request, calls processTransaction and shapes the HTTP response.
 *   Nothing here touches Express: any caller (the route, a test, a later simulation generator)
 *   passes { user, payload, context }.
 *
 *   Steps (all inside the per-user lock, L-08 / N-28):
 *     0. C-01 idempotency replay   — same user + Idempotency-Key → the ORIGINAL result, nothing written
 *     1. load live thresholds, behaviour profile, device reputation, live velocity counts
 *     2. checkFraud (pure) → status
 *     3. insert the transaction with its TXN public id in one write (AUD-05)
 *     4. MEDIUM+ → FraudAlert (C-02 idempotent retry), audit, customer notification, socket event
 *     5. behaviour profile (APPROVED + LOW only), device reputation, trust score — best effort
 *     6. TRANSACTION_SUBMITTED audit entry
 *   Everything after step 3 is best-effort: the payment is saved, so a failing helper must never
 *   turn the request into a 500 (the customer would retry and pay twice, BE-5).
 */
import { checkFraud } from './fraudDetectionService.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import calcBehaviorProfile from '../utils/calcBehaviorProfile.js';
import updateDeviceReputation from '../utils/updateDeviceReputation.js';
import updateTrustScore from '../utils/updateTrustScore.js';
import createNotification from '../utils/createNotification.js';
import createAuditLog from '../utils/createAuditLog.js';
import { withUserLock } from '../utils/userLock.js';
import { formatRupees } from '../utils/normalize.js';
import { getIO } from '../utils/socketManager.js';
import { ALERT_RISK_LEVELS } from '../utils/enums.js';
import { isDeviceCapReached } from '../utils/deviceCap.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';

/**
 * Post-commit helpers must never turn an already-saved transaction into an HTTP
 * 500 (the customer would retry and pay twice): log and carry on (BE-5).
 */
const bestEffort = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[transactionService] ${label} failed after the transaction was saved:`, err.message);
    return null;
  }
};

/** Keep only the known location fields (the validator already guarantees they are strings). */
const pickLocation = (location) => {
  const picked = {};
  if (location?.city !== undefined) picked.city = location.city;
  if (location?.country !== undefined) picked.country = location.country;
  return picked;
};

/**
 * C-02: create the alert for a transaction exactly once. If an earlier attempt actually wrote
 * the alert but reported an error (timeout / dropped reply), the unique index on
 * FraudAlert.transactionId rejects the retry: return the alert that already exists
 * instead of failing (or creating a second one).
 */
const createAlertOnce = async (alertDoc) => {
  try {
    return await FraudAlertModel.create(alertDoc);
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await FraudAlertModel.findOne({ transactionId: alertDoc.transactionId });
      if (existing) return existing;
    }
    throw err;
  }
};

/** One alert type per alert: the rule that fired, COMPOSITE when several different rules did. */
const alertTypeFromSignals = (signals) => (signals.length === 1 ? signals[0] : 'COMPOSITE');

// recommendedAction → transaction status.
//   OTP is only a label: there is NO OTP step. MEDIUM is approved with an alert
//   (notification to the customer) but is NOT learned as normal behaviour (L-01).
const ACTION_TO_STATUS = { APPROVE: 'APPROVED', OTP: 'APPROVED', HOLD: 'HELD', BLOCK: 'BLOCKED' };

/** Plain {rule,label,points,max} objects (no Mongoose subdocuments) for API output. */
const plainBreakdown = (breakdown) =>
  (breakdown ?? []).map(({ rule, label, points, max }) => ({ rule, label, points, max }));

/**
 * The `data` object of POST /customer-api/transactions, built from the STORED transaction (so a
 * first submission and an idempotent replay produce the same shape).
 * @param {object} txn    the saved Transaction (document or lean object)
 * @param {object|null} alert  its FraudAlert, if any
 */
export const buildTransactionResponse = (txn, alert) => ({
  id: txn._id,
  publicId: txn.publicId,
  amount: txn.amount,
  merchantName: txn.merchantName,
  merchantCategory: txn.merchantCategory,
  paymentMethod: txn.paymentMethod,
  fraudScore: txn.fraudScore,
  riskLevel: txn.riskLevel,
  reasons: [...(txn.reasons ?? [])],
  recommendedAction: txn.recommendedAction,
  estimatedLoss: txn.estimatedLoss,
  status: txn.status,
  fraudAlert: alert ? { id: alert._id } : null,
  timestamp: txn.timestamp,
  scoreBreakdown: plainBreakdown(txn.scoreBreakdown), // B-01
});

/** C-01: the transaction this user already stored under `idempotencyKey`, with its alert. */
const RULE_ALERT_TYPES = {
  velocity: 'VELOCITY_BREACH', amount: 'AMOUNT_ANOMALY', location: 'LOCATION_DEVIATION',
  device: 'NEW_DEVICE', time: 'UNUSUAL_HOUR', merchant: 'HIGH_RISK_MERCHANT',
};

const findReplay = async (userId, idempotencyKey) => {
  const transaction = await TransactionModel.findOne({ userId, idempotencyKey });
  if (!transaction) return null;
  let alert = await FraudAlertModel.findOne({ transactionId: transaction._id });
  // R-05: the original attempt saved the payment but its alert insert failed (best effort, BE-5). The customer's retry
  // is the second chance: without an alert a HIGH / CRITICAL payment could never be reviewed. Same idempotent insert.
  if (!alert && ALERT_RISK_LEVELS.includes(transaction.riskLevel)) {
    const fired = (transaction.scoreBreakdown ?? []).filter((r) => r.points > 0).map((r) => RULE_ALERT_TYPES[r.rule]);
    alert = await bestEffort('fraud alert creation (replay)', () => createAlertOnce({
      transactionId: transaction._id,
      userId,
      alertType: alertTypeFromSignals(fired),
      riskLevel: transaction.riskLevel,
      fraudScore: transaction.fraudScore,
      reasons: [...(transaction.reasons ?? [])],
      status: 'OPEN',
    }));
  }
  return {
    transaction,
    alert,
    replayed: true,
    fraud: {
      fraudScore: transaction.fraudScore,
      riskLevel: transaction.riskLevel,
      reasons: [...transaction.reasons],
      recommendedAction: transaction.recommendedAction,
      estimatedLoss: transaction.estimatedLoss,
      breakdown: plainBreakdown(transaction.scoreBreakdown),
      rawScore: transaction.scoreBreakdown.reduce((sum, r) => sum + r.points, 0),
    },
  };
};

/**
 * Score, store and follow up one payment for `user`.
 *
 * @param {object} args
 * @param {{ _id: any }} args.user   the paying customer (req.user)
 * @param {object} args.payload      { amount, merchantName, merchantCategory?, paymentMethod, deviceId,
 *                                     location, idempotencyKey? } — already validated / sanitised
 * @param {{ ip?: string, simulated?: boolean }} [args.context]  request context (client ip for the audit trail;
 *                                   `simulated` is set ONLY by the admin simulation generator, never from a request, A-08)
 * @returns {Promise<{ transaction: object, alert: object|null, fraud: object, replayed: boolean }>}
 *   `replayed` is true when `payload.idempotencyKey` matched an earlier transaction of this user: that
 *   transaction is returned and NOTHING is written. The payload of a replay is ignored (the original
 *   result wins even when amount / merchant differ).
 */
export const processTransaction = async ({ user, payload, context = {} }) => {
  const { amount, merchantName, merchantCategory, paymentMethod, deviceId, idempotencyKey } = payload;
  const location = pickLocation(payload.location);
  const userId = user._id;
  const ip = context.ip;
  const simulated = context.simulated === true; // A-08

  // L-08 / N-28: one submission at a time PER USER. Velocity, trust score, device
  // reputation and the behaviour profile are all read-then-write; overlapping
  // requests of one user used to read the same snapshot (12 parallel payments → no
  // velocity flag) and could write derived scores out of order.
  return withUserLock(userId, async () => {
    // 0. C-01: a retry with a key we already stored returns the original result.
    //    Inside the lock, so two simultaneous requests with one key create ONE transaction.
    if (idempotencyKey) {
      const replay = await findReplay(userId, idempotencyKey);
      if (replay) return replay;
    }

    // 1. Load live thresholds — never hardcode (D-P4-08)
    //    AUD-18: .lean() — a hydrated Mongoose document must not reach the threshold merge.
    const thresholds = await SystemConfigModel.findOne({ singleton: 'system' }).lean();

    // 2. Fetch behavioral context for fraud evaluation.
    //    AUD-03: velocity is counted LIVE at check time. The stored
    //    transactionVelocity is a snapshot from the customer's previous
    //    transaction, so five purchases yesterday still read "5 in the last
    //    hour" today. All outcomes count (a burst of blocked attempts is
    //    velocity too). The current transaction is not saved yet, so the counts
    //    are prior transactions only — consistent with the >= rule (C-P5-01).
    const now = Date.now();
    const [behaviorProfile, deviceReputation, txnsLastHour, txnsLastDay] = await Promise.all([
      BehaviorProfileModel.findOne({ userId }).lean(),
      DeviceReputationModel.findOne({ deviceId }).lean(),
      TransactionModel.countDocuments({ userId, timestamp: { $gte: new Date(now - 60 * 60 * 1000) } }),
      TransactionModel.countDocuments({ userId, timestamp: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    ]);
    // C-08: an unknown device id of a user who already used the maximum number of devices is scored as usual
    // (it is "unrecognised" to the behaviour profile) but never gets a DeviceReputation document.
    const deviceCapped = await bestEffort('device cap check', () => isDeviceCapReached(userId, deviceId, Boolean(deviceReputation)));
    const profileForCheck = {
      ...(behaviorProfile ?? {}),
      transactionVelocity: { perHour: txnsLastHour, perDay: txnsLastDay },
    };

    // 3. Build transaction input for the pure fraud service function
    const transactionInput = {
      amount,
      merchantName,
      merchantCategory: merchantCategory ?? 'GENERAL',
      paymentMethod,
      location,
      deviceId,
      userId,
      timestamp: new Date(),
    };

    // 4. Run fraud detection — pure function, no DB side-effects (D-P4-05)
    const fraud = checkFraud({
      transaction: transactionInput,
      behaviorProfile: profileForCheck,
      deviceReputation,
      thresholds,
    });
    const { fraudScore, riskLevel, reasons, recommendedAction, estimatedLoss, signals, breakdown } = fraud;

    // 5. Map recommendedAction → transaction status
    const status = ACTION_TO_STATUS[recommendedAction] ?? 'HELD';

    // 6. Persist transaction together with its TXN-YYYY-NNNNN public ID in a
    //    single insert (AUD-05 — replaces create-then-save, D-P4-07 revised)
    let transaction;
    try {
      transaction = await createWithSequentialId(TransactionModel, 'publicId', 'TXN', {
        userId,
        amount,
        merchantName,
        merchantCategory: merchantCategory ?? 'GENERAL',
        paymentMethod,
        location,
        deviceId,
        ipAddress: ip,
        fraudScore,
        riskLevel,
        reasons,
        scoreBreakdown: breakdown,
        recommendedAction,
        estimatedLoss,
        status,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(simulated ? { isSimulated: true } : {}), // A-08
      });
    } catch (err) {
      // Backstop for several server instances (the lock is per process): the unique
      // (userId, idempotencyKey) index rejected the loser of the race → replay the winner.
      if (idempotencyKey && err?.code === 11000) {
        const replay = await findReplay(userId, idempotencyKey);
        if (replay) return replay;
      }
      throw err;
    }

    // 7. Public ID was assigned atomically at insert time (AUD-05)
    const { publicId } = transaction;

    // 8. MEDIUM+ risk: create FraudAlert and Customer notification.
    //    Everything here runs after the transaction was saved, so all of it
    //    (alert, audit entry, notification, socket event) is best-effort (BE-5).
    let fraudAlert = null;
    if (ALERT_RISK_LEVELS.includes(riskLevel)) {
      // L-15: the type comes from the rules that fired, not from parsing reason text.
      const alertType = alertTypeFromSignals(signals);

      // The transaction is already saved: a failing alert insert must not turn
      // the request into a 500 (the customer would retry and pay twice).
      // Analysts can only open a case from an alert, so one retry is made before giving up
      // (a HIGH / CRITICAL payment without an alert could not be reviewed or released).
      const alertDoc = {
        transactionId: transaction._id,
        userId,
        alertType,
        riskLevel,
        fraudScore,
        reasons,
        status: 'OPEN',
      };
      fraudAlert = await bestEffort('fraud alert creation', () => createAlertOnce(alertDoc))
        ?? await bestEffort('fraud alert creation (retry)', () => createAlertOnce(alertDoc)); // C-02: idempotent

      if (fraudAlert) {
        await createAuditLog( // BS-19: alert creation is part of the audit trail
          userId,
          'CUSTOMER',
          'FRAUD_ALERT_CREATED',
          'FraudAlert',
          fraudAlert._id.toString(),
          { transactionId: publicId, alertType, riskLevel, fraudScore },
          ip
        );

        await bestEffort('customer notification', () => createNotification({
          recipientId: userId,
          recipientRole: 'CUSTOMER',
          type: 'FRAUD_ALERT',
          title: `${riskLevel} Risk Transaction Detected`,
          message: `Your transaction of ₹${formatRupees(amount)} at ${merchantName} was flagged. Fraud score: ${fraudScore}/100.`,
          relatedEntityId: fraudAlert._id,
          relatedEntityType: 'FRAUD_ALERT',
        }));
      }

      // Push live event to admin WebSocket room (non-fatal — C-P4-03)
      try {
        getIO().emit('fraud_alert', {
          transactionId: transaction._id,
          publicId,
          userId,
          amount,
          merchantName,
          riskLevel,
          fraudScore,
          timestamp: transaction.timestamp,
        });
      } catch (_) { /* socket not yet initialized — non-fatal */ }
    }

    // 9. Update behavioral profile — only APPROVED + LOW-risk transactions teach
    //    the trusted baseline (C-P4-01 revised by AUD-37 and L-01):
    //      • HELD / BLOCKED are suspected fraud;
    //      • MEDIUM is approved (no OTP step exists) but is suspicious by
    //        definition — learning from it let an attacker's new device and
    //        city become "usual" after one attempt.
    //    (A transaction an analyst later DISMISSES joins the baseline then — B-03.)
    //    updateDeviceReputation and updateTrustScore run for all outcomes (AUD-09).
    //    The device lock keeps two customers who share a device from writing a
    //    stale reputation over a fresher one (N-28).
    const shouldUpdateBehaviorProfile = status === 'APPROVED' && riskLevel === 'LOW';
    await Promise.all([
      shouldUpdateBehaviorProfile
        ? bestEffort('behaviour profile update', () => calcBehaviorProfile(userId))
        : Promise.resolve(),
      deviceCapped
        ? Promise.resolve() // C-08
        : bestEffort('device reputation update', () =>
          withUserLock(`device:${deviceId}`, () => updateDeviceReputation(deviceId, userId, transaction))),
      bestEffort('trust score update', () => updateTrustScore(userId)),
    ]);

    // 10. Audit log
    await createAuditLog(
      userId,
      'CUSTOMER',
      'TRANSACTION_SUBMITTED',
      'Transaction',
      publicId,
      { amount, merchantName, paymentMethod, riskLevel, fraudScore, status },
      ip
    );

    return { transaction, alert: fraudAlert, fraud, replayed: false };
  });
};
