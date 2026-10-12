/**
 * @file seed/syncIndexes.js
 * @description OPS: make a database's indexes match the Mongoose schemas:
 *     npm run db:sync-indexes
 *   Mongoose only CREATES missing indexes at start-up. On an existing database that is not enough: a changed
 *   unique/TTL index is rejected (same key, other options), and indexes dropped from the schema (C-05) stay
 *   behind and slow every write. Model.syncIndexes() builds what is missing and drops what the schema no longer
 *   declares. It never reads or changes DATA — only index definitions. Run it from your machine after pulling
 *   an update (a unique index fails to build while duplicates exist: the error names the model).
 *   Refuses to run when MONGODB_URI is not set. Exits 0 on success, 1 on failure.
 */
import '../config/loadEnv.js'; // ⚠️ keep first — loads .env before anything reads process.env

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { getMongoDbName } from '../config/mongoUri.js';
import AuditLogModel from '../models/AuditLogModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import NotificationModel from '../models/NotificationModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import TransactionModel from '../models/TransactionModel.js';
import UserModel from '../models/UserModel.js';

export const ALL_MODELS = Object.freeze([
  UserModel, TransactionModel, FraudAlertModel, FraudCaseModel, NotificationModel,
  AuditLogModel, DeviceReputationModel, BehaviorProfileModel, SystemConfigModel,
]);

/** Throws when the connection string is missing, blank or still a template. @returns {string[]} warnings */
export const assertSyncConfig = (env = process.env) => {
  const uri = (env.MONGODB_URI ?? '').trim();
  if (!uri) throw new Error('MONGODB_URI is not set — nothing to sync (see .env.example)');
  if (/[<>]/.test(uri)) throw new Error('MONGODB_URI still contains a <placeholder> — replace <password> / <dbname> with real values');
  return getMongoDbName(uri) ? [] : ['MONGODB_URI has no database name (…mongodb.net/<dbname>?…) — the driver would use "test"'];
};

/** Index names of a model's collection ([] when the collection does not exist yet). */
const indexNames = async (model) => {
  try {
    return (await model.collection.indexes()).map((index) => index.name);
  } catch (err) {
    if (err?.code === 26 || /ns does not exist|not found/i.test(err?.message ?? '')) return [];
    throw err;
  }
};

/**
 * Sync every model's indexes with its schema.
 * @param {{ modelName: string, syncIndexes: () => Promise<string[]>, collection: any }[]} [models]
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ model: string, created: string[], dropped: string[] }[]>}
 */
export const syncAllIndexes = async (models = ALL_MODELS, log = console.log) => {
  const results = [];
  for (const model of models) {
    const before = await indexNames(model);
    const dropped = (await model.syncIndexes()) ?? [];
    const after = await indexNames(model);
    const created = after.filter((name) => !before.includes(name));
    results.push({ model: model.modelName, created, dropped });
    log(`[sync-indexes] ${model.modelName}: created [${created.join(', ')}] dropped [${dropped.join(', ')}]`);
  }
  return results;
};

export const run = async () => {
  for (const warning of assertSyncConfig(process.env)) console.warn(`[sync-indexes] WARNING: ${warning}`);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  console.log(`[sync-indexes] Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  const results = await syncAllIndexes();
  const created = results.reduce((sum, r) => sum + r.created.length, 0);
  const dropped = results.reduce((sum, r) => sum + r.dropped.length, 0);
  console.log(`[sync-indexes] Done: ${created} index(es) created, ${dropped} dropped. No data was touched.`);
  return results;
};

// Run only when executed directly (`npm run db:sync-indexes`), not when imported by tests.
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
      console.error('[sync-indexes] Failed:', err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}
