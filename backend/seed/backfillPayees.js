/**
 * @file seed/backfillPayees.js
 * @description TEJAS D1, one-time: give every payment made before D1 its payee key, so "first payment to this
 *   payee" and the payee history also count older payments.
 *     npm run db:backfill-payees            (database in MONGODB_URI, e.g. Atlas)
 *     npm run db:backfill-payees:offline    (the offline demo database)
 *   Older payments never had a UPI ID, so their payee is the merchant (utils/payee.js buildPayee). Only payments
 *   WITHOUT a payee are touched, and only the `payee` field is set: running it twice changes nothing the second time.
 *   payeeSignals are NOT invented for old payments (they describe the moment of payment, which is gone).
 *   Refuses to run when MONGODB_URI is not set. Exits 0 on success, 1 on failure.
 */
import '../config/loadEnv.js'; // ⚠️ keep first — loads .env before anything reads process.env

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import TransactionModel from '../models/TransactionModel.js';
import { buildPayee } from '../utils/payee.js';
import { assertSyncConfig } from './syncIndexes.js';

const BATCH = 500;

/**
 * Set `payee` on every transaction that has none. Exported for the tests.
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ scanned: number, updated: number }>}
 */
export const backfillPayees = async (log = console.log) => {
  let scanned = 0;
  let updated = 0;
  let ops = [];
  const flush = async () => {
    if (ops.length === 0) return;
    const result = await TransactionModel.bulkWrite(ops, { ordered: false });
    updated += result.modifiedCount;
    ops = [];
  };

  const cursor = TransactionModel.find({ 'payee.key': { $exists: false } }).select('_id merchantName').lean().cursor();
  for await (const txn of cursor) {
    scanned += 1;
    ops.push({
      updateOne: {
        // Guarded again: a payment that got its payee meanwhile (new D1 payment, second run) is left alone.
        filter: { _id: txn._id, 'payee.key': { $exists: false } },
        update: { $set: { payee: buildPayee({ merchantName: txn.merchantName }) } },
      },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  log(`[backfill-payees] ${scanned} payment(s) without a payee found, ${updated} updated.`);
  return { scanned, updated };
};

export const run = async () => {
  for (const warning of assertSyncConfig(process.env)) console.warn(`[backfill-payees] WARNING: ${warning}`);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  console.log(`[backfill-payees] Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  return backfillPayees();
};

// Run only when executed directly (npm run db:backfill-payees), not when imported by tests.
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isDirectRun()) {
  run()
    .then(async () => {
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[backfill-payees] Failed:', err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}
