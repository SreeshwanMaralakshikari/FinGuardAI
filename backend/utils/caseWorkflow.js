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
 *     RESOLVED  → alert REVIEWED, transaction unchanged
 *     DISMISSED → alert DISMISSED (false positive) and a HELD/BLOCKED
 *                 transaction is released to APPROVED. The customer's trust
 *                 score and the device reputation are recalculated, so
 *                 "lossPrevented" (HELD/BLOCKED only) stops counting it.
 *   The customer receives an in-app notification about the outcome.
 */
import FraudAlertModel from '../models/FraudAlertModel.js';
import TransactionModel from '../models/TransactionModel.js';
import createNotification from './createNotification.js';
import createAuditLog from './createAuditLog.js';
import updateTrustScore from './updateTrustScore.js';
import updateDeviceReputation from './updateDeviceReputation.js';
import { formatRupees } from './normalize.js';
import { withUserLock } from './userLock.js';

export const CLOSED_STATUSES = Object.freeze(['RESOLVED', 'DISMISSED']);
export const OPEN_STATUSES = Object.freeze(['OPEN', 'ASSIGNED', 'UNDER_REVIEW']);

export const ALLOWED_TRANSITIONS = Object.freeze({
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

const outcomeMessage = ({ status, transaction, released }) => {
  const what = transaction
    ? `your transaction ${transaction.publicId} of ₹${formatRupees(transaction.amount)} at ${transaction.merchantName}`
    : 'your flagged transaction';

  if (status === 'DISMISSED') {
    return {
      title: 'Flagged Transaction Cleared',
      message: released
        ? `Our fraud team reviewed ${what} and found no fraud. It has been released and is now approved.`
        : `Our fraud team reviewed ${what} and found no fraud. The alert has been closed.`,
    };
  }
  const statusNote = transaction && ['HELD', 'BLOCKED'].includes(transaction.status)
    ? ` The transaction remains ${transaction.status.toLowerCase()}.`
    : '';
  return {
    title: 'Fraud Review Completed',
    message: `Our fraud team has completed the review of ${what}. The alert has been closed.${statusNote}`,
  };
};

/**
 * Apply the consequences of a case reaching RESOLVED or DISMISSED.
 * Called after the case itself was closed atomically. Alert / transaction updates
 * are single-document writes (their errors propagate); everything that merely
 * informs people or recalculates derived scores is best-effort.
 *
 * @param {object} args
 * @param {import('mongoose').Document} args.fraudCase  the closed case (post-update)
 * @param {'RESOLVED'|'DISMISSED'} args.status
 * @param {{ _id: any }} args.analyst   req.user
 * @param {string} [args.ip]
 * @returns {Promise<{ released: boolean }>}
 */
export const applyCaseOutcome = async ({ fraudCase, status, analyst, ip = '' }) => {
  const dismissed = status === 'DISMISSED';
  const alertStatus = dismissed ? 'DISMISSED' : 'REVIEWED';

  const [alert, transactionBefore] = await Promise.all([
    FraudAlertModel.findById(fraudCase.fraudAlertId).lean(),
    TransactionModel.findById(fraudCase.transactionId).lean(),
  ]);

  // Idempotent: a retry after a failed close finds the alert already updated and
  // audited, so nothing is written twice and the audit "previous status" stays true.
  if (alert && alert.status !== alertStatus) {
    await FraudAlertModel.updateOne({ _id: alert._id }, { $set: { status: alertStatus } });
    await createAuditLog(analyst._id, 'ANALYST', 'FRAUD_ALERT_STATUS_CHANGED', 'FraudAlert', alert._id.toString(),
      { caseId: fraudCase.publicId, previousStatus: alert.status, newStatus: alertStatus }, ip);
  }

  // DISMISSED = false positive: release a held / blocked payment.
  let released = false;
  if (dismissed && transactionBefore && ['HELD', 'BLOCKED'].includes(transactionBefore.status)) {
    const result = await TransactionModel.updateOne(
      { _id: transactionBefore._id, status: { $in: ['HELD', 'BLOCKED'] } },
      { $set: { status: 'APPROVED' } }
    );
    released = result.modifiedCount > 0;
  }
  const transaction = transactionBefore ? { ...transactionBefore, status: released ? 'APPROVED' : transactionBefore.status } : null;

  const bestEffort = async (label, fn) => {
    try { await fn(); } catch (err) { console.error(`[caseWorkflow] ${label} failed:`, err.message); }
  };

  if (released) {
    await createAuditLog(analyst._id, 'ANALYST', 'TRANSACTION_RELEASED', 'Transaction', transactionBefore.publicId,
      { caseId: fraudCase.publicId, previousStatus: transactionBefore.status, newStatus: 'APPROVED' }, ip);
    // A released false positive no longer counts against the customer / device.
    // Same lock order as transaction submission (user, then device) so a
    // concurrent payment never sees, or overwrites, a half-updated score.
    await bestEffort('trust score / device reputation recalculation', () =>
      withUserLock(transactionBefore.userId, async () => {
        await updateTrustScore(transactionBefore.userId);
        await withUserLock(`device:${transactionBefore.deviceId}`, () =>
          updateDeviceReputation(transactionBefore.deviceId, transactionBefore.userId, transactionBefore, { release: true }));
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

  return { released };
};
