/**
 * calcBehaviorProfile.js
 *
 * Recalculates and upserts the BehaviorProfile for a user after a LOW-risk
 * APPROVED transaction (C-P4-01, revised by AUD-37 and L-01).
 *
 * AUD-37 / L-01: the profile is the customer's TRUSTED baseline, so it is built
 * from APPROVED, LOW-risk transactions only.
 *   • HELD / BLOCKED (suspected fraud) must never become "usual" — runtime
 *     showed HELD → APPROVED → APPROVED-without-alert for the same ₹60,000 buy.
 *   • MEDIUM transactions are also APPROVED (there is no OTP step), but they
 *     are suspicious by definition: an attacker's new device + new city scores
 *     MEDIUM, and learning from it made the identical repeat score 0. They
 *     stay out of the baseline, so every repeat is scored MEDIUM again.
 *
 * Purpose:
 *   Queries all of the user's APPROVED + LOW transactions (including the one
 *   just saved) to recompute behavioural statistics:
 *     • avgTransactionAmount  — arithmetic mean over ALL qualifying txns
 *                               (an all-time mean, not a rolling window)
 *     • maxTransactionAmount  — maximum single-transaction amount seen
 *     • usualLocations        — top-5 cities by frequency (case-insensitive;
 *                               the first-seen spelling is kept for display)
 *     • usualHours            — top-3 hours-of-day (0–23, APP_TIME_ZONE)
 *     • usualPaymentMethods   — distinct payment methods seen
 *     • knownDeviceIds        — distinct device fingerprints seen
 *     • transactionVelocity   — {perHour, perDay}: ALL of the user's transactions
 *                               in the last 1h / 24h, the same live definition
 *                               the fraud check uses
 *     • lastUpdated           — timestamp of this recalculation
 *
 * Note (Phase 3 N-01):
 *   The BehaviorProfileModel.usualHours custom validator fires on .save() only,
 *   not on findOneAndUpdate().  getHourInAppZone() always returns 0–23, so the
 *   constraint is naturally satisfied on this upsert path.
 *
 * Exported function:
 *   calcBehaviorProfile(userId, transaction) → Promise<BehaviorProfileDocument|null>
 *
 * @param {ObjectId|string}          userId      The customer's user ID
 * @param {import('mongoose').Document} transaction The saved TransactionModel document
 * @returns {Promise<import('mongoose').Document|null>} The upserted BehaviorProfile (null if nothing qualifies)
 */

import TransactionModel from '../models/TransactionModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import { getHourInAppZone } from '../config/timeZone.js';
import { normalizeCity } from './normalize.js';

/** Keys of `counts` (a Map key → { label, count }) ordered by count, highest first, capped at `limit`. */
const topEntries = (counts, limit) =>
  [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);

const calcBehaviorProfile = async (userId, transaction) => {
  const now = new Date();
  const oneDayAgo  = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() -  1 * 60 * 60 * 1000);

  // The just-saved txn is already committed to the DB at this point (Phase 4
  // step order), so it is part of `trusted`.
  const [trusted, perDayCount, perHourCount] = await Promise.all([
    TransactionModel.find({ userId, status: 'APPROVED', riskLevel: 'LOW' })
      .select('amount location paymentMethod deviceId timestamp')
      .sort({ timestamp: 1 }) // oldest first: "first-seen spelling" of a city is deterministic (uses the userId+timestamp index)
      .lean(),

    TransactionModel.countDocuments({ userId, timestamp: { $gte: oneDayAgo } }),
    TransactionModel.countDocuments({ userId, timestamp: { $gte: oneHourAgo } }),
  ]);

  // Not reachable from CustomerAPI (it only calls this after saving an
  // APPROVED + LOW transaction). Guard anyway so the maths below never divides by 0.
  if (trusted.length === 0) return null;

  // One pass over the transactions: no Math.max(...array) spread, which throws
  // a RangeError once a customer has ~100k+ transactions (L-15).
  let totalAmount = 0;
  let maxTransactionAmount = 0;
  const cities = new Map();   // normalised city → { label, count }
  const hours = new Map();    // hour → { label: hour, count }
  const paymentMethods = new Set();
  const deviceIds = new Set();

  for (const t of trusted) {
    const amount = t.amount ?? 0;
    totalAmount += amount;
    if (amount > maxTransactionAmount) maxTransactionAmount = amount;

    const city = typeof t.location?.city === 'string' ? t.location.city.trim() : '';
    const cityKey = normalizeCity(city);
    if (cityKey && cityKey !== 'unknown') {
      const entry = cities.get(cityKey) ?? { label: city, count: 0 };
      entry.count += 1;
      cities.set(cityKey, entry);
    }

    const hour = getHourInAppZone(t.timestamp); // always 0–23
    const hourEntry = hours.get(hour) ?? { label: hour, count: 0 };
    hourEntry.count += 1;
    hours.set(hour, hourEntry);

    if (t.paymentMethod) paymentMethods.add(t.paymentMethod);
    if (t.deviceId) deviceIds.add(t.deviceId);
  }

  const avgTransactionAmount = totalAmount / trusted.length;
  const usualLocations = topEntries(cities, 5).map((e) => e.label);    // top 5 cities (D-P5-04)
  const usualHours = topEntries(hours, 3).map((e) => e.label);         // top 3 hours (D-P5-04)

  // ── Upsert with findOneAndUpdate (upsert: true) ───────────────────────────
  // N-01 (Phase 3): usualHours validator does not fire on findOneAndUpdate —
  // safe here because getHourInAppZone() always returns 0–23.
  return BehaviorProfileModel.findOneAndUpdate(
    { userId },
    {
      $set: {
        avgTransactionAmount,
        maxTransactionAmount,
        usualLocations,
        usualHours,
        usualPaymentMethods: [...paymentMethods],
        knownDeviceIds: [...deviceIds],
        transactionVelocity: { perHour: perHourCount, perDay: perDayCount },
        lastUpdated: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
};

export default calcBehaviorProfile;
