/**
 * updateTrustScore.js
 *
 * Recalculates a customer's Trust Score (0–100) from their own transaction
 * history. Called by POST /customer-api/transactions after every transaction,
 * for every outcome (AUD-09).
 *
 * Why: Phase 3 documents UserModel.trustScore as "recalculated after
 * transactions", but no code ever updated it — every customer stayed at the
 * default 50 regardless of behaviour (verified at runtime).
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

import TransactionModel from '../models/TransactionModel.js';
import UserModel from '../models/UserModel.js';

const HELD_CREDIT = 0.5;

const updateTrustScore = async (userId) => {
  const [total, approved, held] = await Promise.all([
    TransactionModel.countDocuments({ userId }),
    TransactionModel.countDocuments({ userId, status: 'APPROVED' }),
    TransactionModel.countDocuments({ userId, status: 'HELD' }),
  ]);

  const trustScore = Math.min(
    100,
    Math.max(0, Math.round(((approved + HELD_CREDIT * held + 1) / (total + 2)) * 100))
  );

  // updateOne (not save): no pre-save hook, no full-document validation needed
  await UserModel.updateOne({ _id: userId }, { $set: { trustScore } });
  return trustScore;
};

export default updateTrustScore;
