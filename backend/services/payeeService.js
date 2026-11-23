/**
 * @file services/payeeService.js
 * @description TEJAS D1: payee intelligence.
 *
 *   computePayeeSignals  — what is known about the payee when a payment is submitted (earlier payments only):
 *                          first payment of this customer to it, how long anyone has been paying it, how many
 *                          different customers paid it in the last 24 h (mule accounts collect from many victims),
 *                          how much it received in 24 h, and whether it is on the watchlist.
 *                          Step 1 ("shadow mode"): the signals are stored and shown to analysts but do NOT change the
 *                          fraud score yet. Step 2 adds them to the rule engine and the ML model.
 *   watchlist            — add (analyst, or automatically on confirmed fraud), remove (soft), list.
 *   getPayeeProfile      — the analyst's view of one payee: totals, distinct senders, risk mix, recent payments.
 *
 *   Privacy: other customers' activity (senders, inflow) is shown to ANALYSTS only. The customer response carries
 *   only `firstTimePayee` and `watchlisted` (customerPayeeView).
 */
import TransactionModel from '../models/TransactionModel.js';
import PayeeWatchlistModel from '../models/PayeeWatchlistModel.js';
import { buildPayee, PAYEE_KEY_PREFIX } from '../utils/payee.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Evidence kept per watchlist entry (newest case ids). */
export const MAX_WATCHLIST_CASE_IDS = 20;
/** Recent payments shown on a payee profile. */
export const PROFILE_RECENT_LIMIT = 20;

/** Whole days between two instants, never negative. */
const wholeDaysBetween = (from, to) => Math.max(0, Math.floor((to - from) / DAY_MS));

/** Rupee sums are doubles: round to paise so a sum never shows float noise such as 300.00000000000006. */
const roundPaise = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Signals about `payeeKey` for a payment of `userId` being submitted at `now`.
 * Counts EARLIER payments only (the current one is not saved yet), exactly like the velocity counts.
 *
 * @param {{ userId: any, payeeKey: string, now?: number }} args
 * @returns {Promise<{ firstTimePayee: boolean, payeeAgeDays: number, sendersLast24h: number,
 *                     inflowLast24h: number, watchlisted: boolean }>}
 */
export const computePayeeSignals = async ({ userId, payeeKey, now = Date.now() }) => {
  const since24h = new Date(now - DAY_MS);
  const [paidBefore, firstPayment, last24h, watch] = await Promise.all([
    TransactionModel.exists({ userId, 'payee.key': payeeKey }),
    TransactionModel.findOne({ 'payee.key': payeeKey }).sort({ timestamp: 1, _id: 1 }).select('timestamp').lean(),
    TransactionModel.aggregate([
      { $match: { 'payee.key': payeeKey, timestamp: { $gte: since24h } } },
      { $group: { _id: null, senders: { $addToSet: '$userId' }, inflow: { $sum: '$amount' } } },
    ]),
    PayeeWatchlistModel.exists({ key: payeeKey, active: true }),
  ]);
  const window = last24h[0];
  return {
    firstTimePayee: !paidBefore,
    payeeAgeDays: firstPayment ? wholeDaysBetween(new Date(firstPayment.timestamp).getTime(), now) : 0,
    sendersLast24h: window ? window.senders.length : 0,
    inflowLast24h: window ? roundPaise(window.inflow) : 0,
    watchlisted: Boolean(watch),
  };
};

/**
 * What the paying customer may see about the payee: their own history and the watchlist warning only.
 * @param {object|null|undefined} signals  Transaction.payeeSignals
 * @returns {{ firstTimePayee: boolean, watchlisted: boolean } | null}
 */
export const customerPayeeView = (signals) => (signals
  ? { firstTimePayee: Boolean(signals.firstTimePayee), watchlisted: Boolean(signals.watchlisted) }
  : null);

/** Plain copy of the stored payee for API output (null on payments made before D1). */
export const plainPayee = (payee) => {
  if (!payee?.key) return null;
  return payee.vpa ? { key: payee.key, vpa: payee.vpa } : { key: payee.key };
};

/** Plain copy of the stored signals for analyst output (null on payments made before D1). */
export const plainPayeeSignals = (signals) => {
  if (!signals) return null;
  const { firstTimePayee, payeeAgeDays, sendersLast24h, inflowLast24h, watchlisted } = signals;
  return { firstTimePayee, payeeAgeDays, sendersLast24h, inflowLast24h, watchlisted };
};

/** Watchlist entry as returned by the API (no internal fields). */
const plainEntry = (entry) => ({
  id: entry._id,
  key: entry.key,
  ...(entry.vpa ? { vpa: entry.vpa } : {}),
  label: entry.label,
  source: entry.source,
  note: entry.note ?? '',
  active: entry.active,
  caseCount: entry.caseIds?.length ?? 0,
  addedBy: entry.addedBy,
  addedAt: entry.addedAt,
  ...(entry.removedAt ? { removedBy: entry.removedBy, removedAt: entry.removedAt, removalNote: entry.removalNote ?? '' } : {}),
});

/**
 * Add a payee to the watchlist, or reactivate it. Idempotent for an active entry: the case id (if any) is added as
 * evidence and nothing else changes.
 *
 * @param {object} args
 * @param {string} args.key           payee key (utils/payee.js)
 * @param {string} [args.vpa]
 * @param {string} args.label
 * @param {'CONFIRMED_FRAUD'|'ANALYST_REPORT'} args.source
 * @param {string} [args.note]
 * @param {any} [args.caseId]
 * @param {any} args.actorId          the analyst
 * @returns {Promise<{ entry: object, created: boolean, reactivated: boolean }>}
 */
export const addToWatchlist = async ({ key, vpa, label, source, note = '', caseId, actorId }) => {
  const now = new Date();
  const pushCase = caseId ? { $push: { caseIds: { $each: [caseId], $slice: -MAX_WATCHLIST_CASE_IDS } } } : {};

  // 1. Already active → only record the extra evidence (no write at all without a case id).
  const active = caseId
    ? await PayeeWatchlistModel.findOneAndUpdate({ key, active: true }, pushCase, { returnDocument: 'after' }).lean()
    : await PayeeWatchlistModel.findOne({ key, active: true }).lean();
  if (active) return { entry: plainEntry(active), created: false, reactivated: false };

  // 2. Removed earlier → reactivate the same document (its history stays).
  const reactivated = await PayeeWatchlistModel.findOneAndUpdate(
    { key, active: false },
    {
      $set: { active: true, source, note, label, addedBy: actorId, addedAt: now },
      $unset: { removedBy: 1, removedAt: 1, removalNote: 1 },
      ...pushCase,
    },
    { returnDocument: 'after' }
  ).lean();
  if (reactivated) return { entry: plainEntry(reactivated), created: false, reactivated: true };

  // 3. New. Two analysts adding the same payee at once: the unique index lets one insert win; the loser
  //    retries step 1 and reports the winner's entry.
  try {
    const created = await PayeeWatchlistModel.create({
      key, ...(vpa ? { vpa } : {}), label, source, note,
      caseIds: caseId ? [caseId] : [], addedBy: actorId, addedAt: now, active: true,
    });
    return { entry: plainEntry(created.toObject()), created: true, reactivated: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const winner = caseId
      ? await PayeeWatchlistModel.findOneAndUpdate({ key }, pushCase, { returnDocument: 'after' }).lean()
      : await PayeeWatchlistModel.findOne({ key }).lean();
    if (!winner) throw err;
    return { entry: plainEntry(winner), created: false, reactivated: false };
  }
};

/**
 * Soft-remove an active entry.
 * @returns {Promise<object|null>} the updated entry, or null when no ACTIVE entry has this id
 */
export const removeFromWatchlist = async ({ id, actorId, note = '' }) => {
  const entry = await PayeeWatchlistModel.findOneAndUpdate(
    { _id: id, active: true },
    { $set: { active: false, removedBy: actorId, removedAt: new Date(), removalNote: note } },
    { returnDocument: 'after' }
  ).lean();
  return entry ? plainEntry(entry) : null;
};

/**
 * Watchlist page.
 * @param {{ active?: boolean, skip: number, limit: number }} args  `active` undefined = all entries
 */
export const listWatchlist = async ({ active, skip, limit }) => {
  const filter = active === undefined ? {} : { active };
  const [entries, total] = await Promise.all([
    PayeeWatchlistModel.find(filter)
      .sort({ addedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate('addedBy', 'name')
      .populate('removedBy', 'name')
      .lean(),
    PayeeWatchlistModel.countDocuments(filter),
  ]);
  return { entries: entries.map(plainEntry), total };
};

/**
 * Called when a case is RESOLVED (fraud confirmed). Only UPI-ID payees are added automatically (see the model).
 * Never throws: the case outcome must not fail because of the watchlist.
 *
 * @param {{ transaction: object|null, fraudCase: object, analyst: { _id: any } }} args
 * @returns {Promise<{ entry: object, created: boolean, reactivated: boolean } | null>} null when nothing was added
 */
export const watchlistFromConfirmedFraud = async ({ transaction, fraudCase, analyst }) => {
  const vpa = transaction?.payee?.vpa;
  if (!vpa || !transaction.payee.key?.startsWith(PAYEE_KEY_PREFIX.VPA)) return null;
  try {
    return await addToWatchlist({
      key: transaction.payee.key,
      vpa,
      label: vpa,
      source: 'CONFIRMED_FRAUD',
      note: `Fraud confirmed in case ${fraudCase.publicId}`,
      caseId: fraudCase._id,
      actorId: analyst._id,
    });
  } catch (err) {
    console.error('[payeeService] Could not add the payee to the watchlist:', err.message);
    return null;
  }
};

/**
 * Analyst view of one payee.
 * @param {string} payeeKey  a VALID key (the route checks isPayeeKey first)
 * @returns {Promise<object|null>} null when no payment and no watchlist entry exist for the key
 */
export const getPayeeProfile = async (payeeKey, now = Date.now()) => {
  const since24h = new Date(now - DAY_MS);
  const [totals, last24h, byRisk, recent, watch] = await Promise.all([
    TransactionModel.aggregate([
      { $match: { 'payee.key': payeeKey } },
      {
        $group: {
          _id: null,
          payments: { $sum: 1 },
          amount: { $sum: '$amount' },
          senders: { $addToSet: '$userId' },
          firstAt: { $min: '$timestamp' },
          lastAt: { $max: '$timestamp' },
        },
      },
    ]),
    TransactionModel.aggregate([
      { $match: { 'payee.key': payeeKey, timestamp: { $gte: since24h } } },
      { $group: { _id: null, payments: { $sum: 1 }, amount: { $sum: '$amount' }, senders: { $addToSet: '$userId' } } },
    ]),
    TransactionModel.aggregate([
      { $match: { 'payee.key': payeeKey } },
      { $group: { _id: '$riskLevel', count: { $sum: 1 } } },
    ]),
    TransactionModel.find({ 'payee.key': payeeKey })
      .sort({ timestamp: -1, _id: -1 })
      .limit(PROFILE_RECENT_LIMIT)
      .populate('userId', 'name')
      .select('publicId userId amount merchantName paymentMethod riskLevel fraudScore status timestamp payee')
      .lean(),
    PayeeWatchlistModel.findOne({ key: payeeKey }).populate('addedBy', 'name').populate('removedBy', 'name').lean(),
  ]);

  const all = totals[0];
  if (!all && !watch) return null;
  const day = last24h[0];
  const riskMix = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const row of byRisk) if (row._id in riskMix) riskMix[row._id] = row.count;

  return {
    key: payeeKey,
    label: recent[0]?.payee?.vpa ?? recent[0]?.merchantName ?? watch?.label ?? payeeKey,
    totals: {
      payments: all?.payments ?? 0,
      amount: roundPaise(all?.amount),
      distinctSenders: all?.senders.length ?? 0,
      firstPaymentAt: all?.firstAt ?? null,
      lastPaymentAt: all?.lastAt ?? null,
    },
    last24h: {
      payments: day?.payments ?? 0,
      amount: roundPaise(day?.amount),
      distinctSenders: day?.senders.length ?? 0,
    },
    riskMix,
    watchlist: watch ? plainEntry(watch) : null,
    recentPayments: recent.map((t) => ({
      id: t._id,
      publicId: t.publicId,
      customer: t.userId ? { id: t.userId._id, name: t.userId.name } : null,
      amount: t.amount,
      paymentMethod: t.paymentMethod,
      riskLevel: t.riskLevel,
      fraudScore: t.fraudScore,
      status: t.status,
      timestamp: t.timestamp,
    })),
  };
};

/** Re-exported so callers need one import for everything payee related. */
export { buildPayee };
