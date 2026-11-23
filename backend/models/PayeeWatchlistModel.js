/**
 * @file models/PayeeWatchlistModel.js
 * @description TEJAS D1: payees known to have received fraudulent money (a shared "negative registry", the idea behind
 *   RBI's Digital Payments Intelligence Platform). One document per payee key. An entry is never deleted: removing a
 *   payee sets `active: false` and records who removed it, so the history stays auditable; adding it again reactivates
 *   the same document.
 *
 *   Sources:
 *     CONFIRMED_FRAUD — added automatically when an analyst RESOLVES a case (fraud confirmed) and the payment had a
 *                       UPI ID payee. Merchant-name payees are never added automatically: one fraudulent card payment
 *                       at a large shop does not make the shop a fraudster.
 *     ANALYST_REPORT  — added by an analyst by hand (UPI ID or merchant).
 */
import mongoose from 'mongoose';
import { WATCHLIST_SOURCES } from '../utils/enums.js';

const { Schema } = mongoose;

const payeeWatchlistSchema = new Schema(
  {
    key:      { type: String, required: true, trim: true, maxlength: 220 },   // utils/payee.js buildPayee().key
    vpa:      { type: String, trim: true, maxlength: 100 },                   // set for "vpa:" keys
    label:    { type: String, required: true, trim: true, maxlength: 200 },   // what the UI shows
    source:   { type: String, enum: [...WATCHLIST_SOURCES], required: true },
    note:     { type: String, trim: true, maxlength: 300, default: '' },
    active:   { type: Boolean, default: true },
    // Evidence: the confirmed-fraud cases that put (or kept) this payee on the list. Capped at the last 20 ids.
    caseIds:  { type: [{ type: Schema.Types.ObjectId, ref: 'FraudCase' }], default: [] },
    addedBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
    addedAt:  { type: Date, required: true },
    removedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    removedAt: { type: Date },
    removalNote: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

payeeWatchlistSchema.index({ key: 1 }, { unique: true });
// The analyst list: active entries, newest first.
payeeWatchlistSchema.index({ active: 1, addedAt: -1, _id: -1 });

const PayeeWatchlistModel = mongoose.model('PayeeWatchlist', payeeWatchlistSchema);

export default PayeeWatchlistModel;
