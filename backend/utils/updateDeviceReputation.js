/**
 * updateDeviceReputation.js
 *
 * Upserts the DeviceReputationModel document for a given device fingerprint
 * after every transaction outcome (called for ALL outcomes per C-P4-01).
 *
 * Purpose:
 *   Computes the device's current reputation score from its transaction
 *   history in TransactionModel, then upserts DeviceReputationModel with:
 *     • reputationScore       — smoothed share of trusted outcomes (see below)
 *     • isBlacklisted         — true when reputationScore < 30
 *     • flagCount             — incremented for MEDIUM / HIGH / CRITICAL riskLevel
 *     • fraudTransactionCount — incremented for HIGH / CRITICAL riskLevel
 *     • associatedUserIds     — userId added via $addToSet (no duplicates)
 *     • lastSeenAt            — updated to now on every call
 *     • firstSeenAt           — set only on the very first insert ($setOnInsert)
 *
 * Note (D-P5-05 / Phase 3):
 *   DeviceReputationModel stores no totalTransactions or successfulTransactions
 *   counter fields; those figures are derived from TransactionModel at call time
 *   so they always reflect the accurate state of the ledger.  The current
 *   transaction is already committed to the DB before this function is called
 *   (Phase 4 step order), so countDocuments returns accurate figures.
 *
 * Exported function:
 *   updateDeviceReputation(deviceId, userId, transaction, options?) → Promise<DeviceReputationDocument>
 *
 * @param {string}                      deviceId     Device fingerprint string
 * @param {ObjectId|string}             userId       The customer's user ID
 * @param {import('mongoose').Document} transaction  The saved TransactionModel document (riskLevel populated)
 * @param {{ recalculateOnly?: boolean, release?: boolean }} [options]
 *   recalculateOnly — refresh reputationScore / isBlacklisted from the ledger WITHOUT
 *   counting the transaction again (no flagCount / fraudTransactionCount increment,
 *   lastSeenAt untouched). Used when an analyst releases a false positive (L-02).
 *   release — implies recalculateOnly and also takes the released transaction back out of
 *   flagCount / fraudTransactionCount (never below zero).
 * @returns {Promise<import('mongoose').Document>}   The upserted DeviceReputation document
 */

import TransactionModel from '../models/TransactionModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';

const REPUTATION_PRIOR = 3;   // pseudo-count of trusted history for every device
const HELD_CREDIT = 0.5;      // a HELD transaction counts as half-trusted
const BLACKLIST_BELOW = 30;   // reputationScore below this → isBlacklisted

const updateDeviceReputation = async (deviceId, userId, transaction, { recalculateOnly: recalcOnly = false, release = false } = {}) => {
  const recalculateOnly = recalcOnly || release;
  const now = new Date();

  // ── 1. Compute reputation score from live transaction counts ──────────────
  // AUD-02: the original score was approved / total. A new device whose first
  // transaction was HELD scored 0 → blacklisted → every later transaction got
  // +50 points → HELD again → the score could never recover (verified at
  // runtime: an ordinary ₹500 purchase was rated HIGH forever).
  //
  // Smoothed score:  (approved + 0.5 × held + PRIOR) / (total + PRIOR) × 100
  //   • PRIOR pseudo-transactions of trusted history damp single events
  //   • HELD = suspicious but unconfirmed → half credit; BLOCKED → no credit
  //   • Examples: 1 HELD → 88 · 3 BLOCKED → 50 · 10 BLOCKED → 23 (blacklisted)
  // The current transaction is already persisted (Phase 4 step order), so the
  // counts include it.
  const [totalCount, approvedCount, heldCount] = await Promise.all([
    TransactionModel.countDocuments({ deviceId }),
    TransactionModel.countDocuments({ deviceId, status: 'APPROVED' }),
    TransactionModel.countDocuments({ deviceId, status: 'HELD' }),
  ]);

  const trustedWeight = approvedCount + HELD_CREDIT * heldCount + REPUTATION_PRIOR;
  const reputationScore = Math.min(
    100,
    Math.max(0, Math.round((trustedWeight / (totalCount + REPUTATION_PRIOR)) * 100))
  );

  const isBlacklisted = reputationScore < BLACKLIST_BELOW;

  // ── 2. Derive risk category from the saved transaction ────────────────────
  const riskLevel    = transaction.riskLevel ?? 'LOW';
  const isFlagged    = ['MEDIUM', 'HIGH', 'CRITICAL'].includes(riskLevel);
  const isFraudulent = ['HIGH', 'CRITICAL'].includes(riskLevel);

  // Build $inc object only for the fields that actually need incrementing
  // (avoids creating zero-increment operators when not needed).
  const $inc = {};
  if (isFlagged && !recalculateOnly)    $inc.flagCount            = 1;
  if (isFraudulent && !recalculateOnly) $inc.fraudTransactionCount = 1;

  // ── 3. Upsert DeviceReputationModel ───────────────────────────────────────
  const updateDoc = {
    $set: {
      reputationScore,
      isBlacklisted,
      ...(recalculateOnly ? {} : { lastSeenAt: now }),
    },
    $addToSet: {
      associatedUserIds: userId,
    },
    $setOnInsert: {
      // firstSeenAt is written exactly once — when the document is created.
      firstSeenAt: now,
    },
  };

  // Attach $inc only when there is something to increment.
  if (Object.keys($inc).length > 0) {
    updateDoc.$inc = $inc;
  }

  if (release) {
    // A released false positive is no longer a flag / fraud on this device.
    // The $gt filters keep the counters from ever going negative.
    if (isFlagged) {
      await DeviceReputationModel.updateOne({ deviceId, flagCount: { $gt: 0 } }, { $inc: { flagCount: -1 } });
    }
    if (isFraudulent) {
      await DeviceReputationModel.updateOne({ deviceId, fraudTransactionCount: { $gt: 0 } }, { $inc: { fraudTransactionCount: -1 } });
    }
  }

  return DeviceReputationModel.findOneAndUpdate(
    { deviceId },
    updateDoc,
    { upsert: true, returnDocument: 'after' }
  );
};

export default updateDeviceReputation;
