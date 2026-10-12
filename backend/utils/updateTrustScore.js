/**
 * updateTrustScore.js
 *
 * Recalculates a customer's Trust Score (0–100) from their own transaction
 * history. Called by services/transactionService.js after every submitted
 * transaction, for every outcome (AUD-09), and by utils/caseWorkflow.js when an
 * analyst closes a case and the payment's status changes (a released or
 * confirmed-fraud payment changes the share of trusted outcomes).
 *
 * Why: UserModel.trustScore is documented as "recalculated after transactions";
 * the score always derives from the ledger, so a recalculation is idempotent.
 *
 * Formula (Laplace-smoothed share of trusted outcomes):
 *     trustScore = (approved + 0.5 × held + 1) / (total + 2) × 100
 *   • New customer (no history)      → 50  (matches the schema default)
 *   • 1 approved                     → 67
 *   • 10 approved                    → 92
 *   • 10 approved, 2 blocked         → 79
 *   • HELD = suspicious but unconfirmed → half credit; BLOCKED → no credit
 *
 * Exported function:
 *   updateTrustScore(userId) → Promise<number>  (the new score)
 *
 * @param {ObjectId|string} userId
 * @returns {Promise<number>}
 */

import { countStatuses } from './statusCounts.js';
import UserModel from '../models/UserModel.js';

const HELD_CREDIT = 0.5;

const updateTrustScore = async (userId) => {
  const { total, approved, held } = await countStatuses({ userId }); // C-07: one aggregation

  const trustScore = Math.min(
    100,
    Math.max(0, Math.round(((approved + HELD_CREDIT * held + 1) / (total + 2)) * 100))
  );

  // updateOne (not save): no pre-save hook, no full-document validation needed
  await UserModel.updateOne({ _id: userId }, { $set: { trustScore } });
  return trustScore;
};

export default updateTrustScore;
