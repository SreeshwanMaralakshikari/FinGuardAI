/**
 * @file services/customerResponseService.js
 * @description Round 4: "Was this you?" — the customer's answer on one of their own HELD or BLOCKED payments.
 *
 *   The answer is EVIDENCE for the analyst, not a decision: it never changes the payment's status (an
 *   attacker who controls the account could otherwise release their own payment). It is stored once on the
 *   transaction (Transaction.customerResponse), shown on the analyst's flagged-transaction and case pages,
 *   written to the audit log, and the analysts are notified:
 *     • the analyst the case is assigned to, if there is one;
 *     • otherwise every active analyst (at most MAX_ANALYST_RECIPIENTS), so an unopened alert is not missed.
 *   It can be given only while the alert is still OPEN (not after an analyst closed the case), and only once.
 *
 *   Errors are thrown as { status, message } (CustomerResponseError) for the route to return.
 */
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import UserModel from '../models/UserModel.js';
import createNotification from '../utils/createNotification.js';
import createAuditLog from '../utils/createAuditLog.js';
import { MAX_ANALYST_RECIPIENTS } from '../utils/caseWorkflow.js';
import { formatRupees } from '../utils/normalize.js';

export class CustomerResponseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Statuses on which the customer is asked "Was this you?". */
export const RESPONSE_STATUSES = Object.freeze(['HELD', 'BLOCKED']);

const ANSWER_TEXT = {
  CONFIRMED: 'says they made this payment',
  DISPUTED: 'says they did NOT make this payment',
};

const notifyAnalysts = async ({ transaction, alert, answer, note, customerName }) => {
  const fraudCase = alert ? await FraudCaseModel.findOne({ fraudAlertId: alert._id }).select('_id publicId assignedAnalystId').lean() : null;
  const recipients = fraudCase?.assignedAnalystId
    ? [{ _id: fraudCase.assignedAnalystId }]
    : await UserModel.find({ role: 'ANALYST', isActive: true }).select('_id').sort({ _id: 1 }).limit(MAX_ANALYST_RECIPIENTS).lean();

  const where = fraudCase ? `case ${fraudCase.publicId}` : `flagged payment ${transaction.publicId}`;
  const results = await Promise.allSettled(recipients.map((r) => createNotification({
    recipientId: r._id,
    recipientRole: 'ANALYST',
    type: 'CUSTOMER_RESPONSE',
    title: answer === 'DISPUTED' ? `Customer disputes ${transaction.publicId}` : `Customer confirms ${transaction.publicId}`,
    message: `${customerName ?? 'The customer'} ${ANSWER_TEXT[answer]} (₹${formatRupees(transaction.amount)} at ${transaction.merchantName}, ${where}).${note ? ` Note: "${note}"` : ''}`,
    relatedEntityId: fraudCase?._id ?? transaction._id,
    relatedEntityType: fraudCase ? 'FRAUD_CASE' : 'TRANSACTION',
  })));
  for (const f of results.filter((r) => r.status === 'rejected')) {
    console.error('[customerResponse] could not notify an analyst:', f.reason?.message);
  }
};

/**
 * @param {{ user: { _id, name? }, transactionId: string, answer: 'CONFIRMED'|'DISPUTED', note?: string, ip?: string }} args
 * @returns {Promise<object>} the updated transaction
 */
export const recordCustomerResponse = async ({ user, transactionId, answer, note = '', ip }) => {
  const transaction = await TransactionModel.findOne({ _id: transactionId, userId: user._id });
  if (!transaction) throw new CustomerResponseError(404, 'Transaction not found.');
  if (transaction.customerResponse?.answer) throw new CustomerResponseError(409, 'You have already answered for this payment.');
  if (!RESPONSE_STATUSES.includes(transaction.status)) {
    throw new CustomerResponseError(409, 'Only a held or blocked payment can be confirmed or disputed.');
  }
  const alert = await FraudAlertModel.findOne({ transactionId: transaction._id }).select('_id status').lean();
  if (alert && alert.status !== 'OPEN') {
    throw new CustomerResponseError(409, 'This payment has already been reviewed by the fraud team.');
  }

  // Atomic: a second, simultaneous answer cannot overwrite the first.
  const updated = await TransactionModel.findOneAndUpdate(
    { _id: transaction._id, userId: user._id, status: { $in: [...RESPONSE_STATUSES] }, 'customerResponse.answer': { $exists: false } },
    { $set: { customerResponse: { answer, note: note.trim(), respondedAt: new Date() } } },
    { new: true, runValidators: true },
  );
  if (!updated) throw new CustomerResponseError(409, 'You have already answered for this payment.');

  await createAuditLog(user._id, 'CUSTOMER', 'CUSTOMER_RESPONDED', 'Transaction', updated.publicId, { answer, hasNote: Boolean(note.trim()) }, ip);
  try {
    await notifyAnalysts({ transaction: updated, alert, answer, note: note.trim(), customerName: user.name });
  } catch (err) {
    console.error('[customerResponse] analyst notification failed (the answer is saved):', err.message);
  }
  return updated;
};
