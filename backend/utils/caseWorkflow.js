/**
 * @file utils/caseWorkflow.js
 * @description Rules and side effects of the fraud-case workflow (L-02 / L-04).
 *
 *   Status transitions (enforced by PATCH /analyst-api/cases/:id/status):
 *     OPEN          → (none)  — an OPEN case has no owner; "assign" moves it to ASSIGNED
 *     ASSIGNED      → UNDER_REVIEW | DISMISSED
 *     UNDER_REVIEW  → RESOLVED | DISMISSED
 *     RESOLVED / DISMISSED → closed, nothing may change any more
 *   Only the currently assigned analyst may change the status; reassigning a
 *   case never resets its status.
 *
 *   When a case closes (applyCaseOutcome):
 *     RESOLVED  → "fraud confirmed" (B-02): alert REVIEWED and a HELD transaction becomes
 *                 BLOCKED (a BLOCKED one stays BLOCKED; an APPROVED one is left alone).
 *                 Trust score and device reputation are recalculated.
 *     DISMISSED → alert DISMISSED (false positive) and a HELD/BLOCKED
 *                 transaction is released to APPROVED and stamped releasedByCaseAt, which makes it
 *                 eligible to train the behaviour profile (B-03); the profile is rebuilt. The customer's
 *                 trust score and the device reputation are recalculated, so
 *                 "lossPrevented" (HELD/BLOCKED only) stops counting it.
 *   The alert stays OPEN while its case is open (B-04): it becomes REVIEWED / DISMISSED only here.
 *   The customer receives an in-app notification about the outcome.
 *
 *   Device counter model (DeviceReputation.flagCount / fraudTransactionCount):
 *     • +1 once per transaction when it is submitted (flagCount for MEDIUM/HIGH/CRITICAL,
 *       fraudTransactionCount for HIGH/CRITICAL), whatever its status;
 *     • DISMISSED + released → -1 once (never below 0) via updateDeviceReputation({ release: true });
 *     • RESOLVED (HELD → BLOCKED) is a status change only: the counters already include the
 *       transaction, so they are NOT touched (recalculateOnly refreshes the score alone).
 *     A retry after a failed close cannot double count: the status guards below make the transaction
 *     write a no-op the second time, and side effects only run when the write changed something.
 */
import FraudAlertModel from '../models/FraudAlertModel.js';
import TransactionModel from '../models/TransactionModel.js';
import UserModel from '../models/UserModel.js';
import calcBehaviorProfile from './calcBehaviorProfile.js';
import createNotification from './createNotification.js';
import createAuditLog from './createAuditLog.js';
import updateTrustScore from './updateTrustScore.js';
import updateDeviceReputation from './updateDeviceReputation.js';
import { formatRupees } from './normalize.js';
import { withUserLock } from './userLock.js';

export const CLOSED_STATUSES = Object.freeze(['RESOLVED', 'DISMISSED']);

const ALLOWED_TRANSITIONS = Object.freeze({
  OPEN: [],
  ASSIGNED: ['UNDER_REVIEW', 'DISMISSED'],
  UNDER_REVIEW: ['RESOLVED', 'DISMISSED'],
});

/** @returns {boolean} whether `from → to` is a legal status change */
export const isTransitionAllowed = (from, to) => (ALLOWED_TRANSITIONS[from] ?? []).includes(to);

/** Human-readable explanation for a rejected transition. */
export const describeTransition = (from, to) => {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (from === 'OPEN') return 'This case is not assigned yet. Assign it before changing its status.';
  return `A case that is ${from} cannot move to ${to}. Allowed next status: ${allowed.join(' or ')}.`;
};

/**
 * Titles of the customer notification sent when a case closes (type FRAUD_ALERT, like the alert notice itself).
 * A-02 uses them to recognise case outcomes in the customer timeline.
 */
export const OUTCOME_TITLES = Object.freeze({ DISMISSED: 'Flagged Transaction Cleared', RESOLVED: 'Fraud Confirmed' });

const outcomeMessage = ({ status, transaction, released }) => {
  const what = transaction
    ? `your transaction ${transaction.publicId} of ₹${formatRupees(transaction.amount)} at ${transaction.merchantName}`
    : 'your flagged transaction';

  if (status === 'DISMISSED') {
    return {
      title: OUTCOME_TITLES.DISMISSED,
      message: released
        ? `Our fraud team reviewed ${what} and found no fraud. It has been released and is now approved.`
        : `Our fraud team reviewed ${what} and found no fraud. The alert has been closed.`,
    };
  }
  // RESOLVED = fraud confirmed (B-02)
  const blocked = transaction?.status === 'BLOCKED';
  return {
    title: OUTCOME_TITLES.RESOLVED,
    message: `Our fraud team reviewed ${what} and confirmed it as fraudulent.${blocked ? ' The payment has been blocked.' : ' The alert has been closed.'}`,
  };
};

/**
 * Apply the consequences of a case reaching RESOLVED or DISMISSED.
 * Called after the case itself was closed atomically. Alert / transaction updates
 * are single-document writes (their errors propagate); everything that merely
 * informs people or recalculates derived scores is best-effort.
 * If the alert / transaction writes fail part-way, the part that was written is restored
 * before the error propagates (the caller then reopens the case, so a retry starts clean).
 *
 * @param {object} args
 * @param {import('mongoose').Document} args.fraudCase  the closed case (post-update)
 * @param {'RESOLVED'|'DISMISSED'} args.status
 * @param {{ _id: any }} args.analyst   req.user
 * @param {string} [args.ip]
 * @returns {Promise<{ released: boolean, blocked: boolean }>}
 */
export const applyCaseOutcome = async ({ fraudCase, status, analyst, ip = '' }) => {
  const dismissed = status === 'DISMISSED';
  const alertStatus = dismissed ? 'DISMISSED' : 'REVIEWED';

  const [alert, transactionBefore] = await Promise.all([
    FraudAlertModel.findById(fraudCase.fraudAlertId).lean(),
    TransactionModel.findById(fraudCase.transactionId).lean(),
  ]);

  // ── 1. critical writes (errors propagate, partial progress is rolled back) ──
  // Idempotent: a retry after a failed close finds the alert already updated, so
  // nothing is written twice.
  const alertChanged = Boolean(alert && alert.status !== alertStatus);
  let alertWritten = false;
  let released = false;
  let blocked = false;
  try {
    if (alertChanged) {
      await FraudAlertModel.updateOne({ _id: alert._id }, { $set: { status: alertStatus } });
      alertWritten = true;
    }

    if (transactionBefore) {
      if (dismissed && ['HELD', 'BLOCKED'].includes(transactionBefore.status)) {
        // DISMISSED = false positive: release a held / blocked payment; the stamp lets it train the baseline (B-03).
        const result = await TransactionModel.updateOne(
          { _id: transactionBefore._id, status: { $in: ['HELD', 'BLOCKED'] } },
          { $set: { status: 'APPROVED', releasedByCaseAt: new Date() } }
        );
        released = result.modifiedCount > 0;
      } else if (!dismissed && transactionBefore.status === 'HELD') {
        // RESOLVED = fraud confirmed: a held payment is now blocked for good (B-02).
        const result = await TransactionModel.updateOne(
          { _id: transactionBefore._id, status: 'HELD' },
          { $set: { status: 'BLOCKED' } }
        );
        blocked = result.modifiedCount > 0;
      }
    }
  } catch (err) {
    // The transaction write is the last statement, so only the alert can already be written: put it back,
    // then let the caller reopen the case.
    if (alertWritten) {
      await FraudAlertModel.updateOne({ _id: alert._id, status: alertStatus }, { $set: { status: alert.status } })
        .catch((undoErr) => console.error('[caseWorkflow] Could not restore the alert after a failed close:', undoErr.message));
    }
    throw err;
  }

  const finalStatus = released ? 'APPROVED' : blocked ? 'BLOCKED' : transactionBefore?.status;
  const transaction = transactionBefore ? { ...transactionBefore, status: finalStatus } : null;

  const bestEffort = async (label, fn) => {
    try { await fn(); } catch (err) { console.error(`[caseWorkflow] ${label} failed:`, err.message); }
  };

  // ── 2. audit trail ──
  if (alertChanged) {
    await createAuditLog(analyst._id, 'ANALYST', 'FRAUD_ALERT_STATUS_CHANGED', 'FraudAlert', alert._id.toString(),
      { caseId: fraudCase.publicId, previousStatus: alert.status, newStatus: alertStatus }, ip);
  }
  if (released || blocked) {
    await createAuditLog(analyst._id, 'ANALYST', released ? 'TRANSACTION_RELEASED' : 'TRANSACTION_BLOCKED', 'Transaction',
      transactionBefore.publicId,
      { caseId: fraudCase.publicId, previousStatus: transactionBefore.status, newStatus: finalStatus }, ip);

    // ── 3. derived scores (best-effort) ──
    // A released false positive no longer counts against the customer / device; a confirmed fraud
    // no longer earns the half credit of a HELD payment. Same lock order as transaction submission
    // (user, then device) so a concurrent payment never sees, or overwrites, a half-updated score.
    await bestEffort('trust score / device reputation recalculation', () =>
      withUserLock(transactionBefore.userId, async () => {
        await bestEffort('trust score', () => updateTrustScore(transactionBefore.userId));
        await bestEffort('device reputation', () =>
          withUserLock(`device:${transactionBefore.deviceId}`, () =>
            updateDeviceReputation(
              transactionBefore.deviceId, transactionBefore.userId, transactionBefore,
              released ? { release: true } : { recalculateOnly: true }
            )));
        // B-03: the released transaction is trusted now — rebuild the baseline.
        if (released) await bestEffort('behaviour profile rebuild', () => calcBehaviorProfile(transactionBefore.userId));
      }));
  }

  // Tell the customer how it ended (in-app notification, existing mechanism).
  const recipientId = alert?.userId ?? transactionBefore?.userId;
  if (recipientId) {
    await bestEffort('customer notification', () => createNotification({
      recipientId,
      recipientRole: 'CUSTOMER',
      type: 'FRAUD_ALERT',
      ...outcomeMessage({ status, transaction, released }),
      relatedEntityId: alert?._id ?? fraudCase.fraudAlertId,
      relatedEntityType: 'FRAUD_ALERT',
    }));
  }

  return { released, blocked };
};

/** A-03: at most this many analysts are told about one case status change. */
export const MAX_ANALYST_RECIPIENTS = 50;

const STATUS_LABELS = Object.freeze({ UNDER_REVIEW: 'Under Review', RESOLVED: 'Resolved', DISMISSED: 'Dismissed' });

/**
 * A-03: tell every OTHER active analyst (never the actor; max MAX_ANALYST_RECIPIENTS) that a case
 * changed status. Failures are logged and swallowed: this must never fail the request.
 * @returns {Promise<number>} how many notifications were created
 */
export const notifyAnalystsOfStatusChange = async ({ fraudCase, previousStatus, newStatus, actor }) => {
  try {
    const recipients = await UserModel.find({ role: 'ANALYST', isActive: true, _id: { $ne: actor._id } })
      .select('_id')
      .sort({ _id: 1 })
      .limit(MAX_ANALYST_RECIPIENTS)
      .lean();

    const results = await Promise.allSettled(recipients.map((r) => createNotification({
      recipientId: r._id,
      recipientRole: 'ANALYST',
      type: 'CASE_STATUS_CHANGED',
      title: `Case ${fraudCase.publicId}: ${STATUS_LABELS[newStatus] ?? newStatus}`,
      message: `Case ${fraudCase.publicId} moved from ${previousStatus} to ${newStatus} (updated by ${actor.name ?? 'an analyst'}).`,
      relatedEntityId: fraudCase._id,
      relatedEntityType: 'FRAUD_CASE',
    })));
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) console.error('[caseWorkflow] Could not notify an analyst of the status change:', f.reason?.message);
    return results.length - failed.length;
  } catch (err) {
    console.error('[caseWorkflow] Could not notify analysts of the status change:', err.message);
    return 0;
  }
};
