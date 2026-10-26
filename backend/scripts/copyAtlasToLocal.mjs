/**
 * @file scripts/copyAtlasToLocal.mjs
 * @description Copies the live database (MONGODB_URI in backend/.env, i.e. Atlas) into the local offline
 *   database (MONGODB_URI in backend/.env.offline), so the laptop shows exactly the same users, payments,
 *   alerts, cases, audit log and settings as the live site — without internet.
 *
 *     npm run offline:copy        (needs internet while it runs; run it before the exam)
 *
 *   • Atlas is only READ. Nothing there is changed.
 *   • The local database is replaced: it is dropped first, then every collection and its indexes are copied.
 *     For safety the target must be on this machine (localhost / 127.0.0.1) and must differ from the source.
 *   • Run it again any time to refresh the local copy.
 *   Passwords stay hashed (bcrypt), so every account signs in with the same password as on the live site.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { getMongoDbName, isLocalMongoUri } from '../config/mongoUri.js';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = 1000;
// Index options that MongoDB returns from listIndexes but must not be passed back to createIndexes.
const INDEX_NOISE = ['v', 'ns', 'background'];

const readUri = (file) => {
  const path = join(BACKEND, file);
  if (!existsSync(path)) return '';
  return (dotenv.parse(readFileSync(path)).MONGODB_URI ?? '').trim();
};

/**
 * Throws unless copying `source` over `target` is safe. Pure, so it is unit-testable.
 * @param {string} source  live database URI
 * @param {string} target  local database URI (will be dropped)
 */
export const assertCopyTargets = (source, target) => {
  if (!source) throw new Error('No MONGODB_URI in backend/.env (the live database to copy from).');
  if (!target) throw new Error('No MONGODB_URI in backend/.env.offline. Run `npm run offline:setup` first.');
  if (!isLocalMongoUri(target)) {
    throw new Error('The offline database must be on this machine (localhost / 127.0.0.1); refusing to overwrite a remote database.');
  }
  if (!getMongoDbName(target)) throw new Error('The offline MONGODB_URI must name a database, e.g. mongodb://127.0.0.1:27017/finguardai_offline');
  if (!getMongoDbName(source)) throw new Error('The live MONGODB_URI in backend/.env has no database name, so it is unclear what to copy.');
  if (source === target) throw new Error('backend/.env and backend/.env.offline point at the same database; nothing to copy.');
};

/** Copies one collection's documents (in batches) and its secondary indexes. Returns the document count. */
const copyCollection = async (srcDb, dstDb, name) => {
  const src = srcDb.collection(name);
  const dst = dstDb.collection(name);
  let count = 0;
  let batch = [];
  for await (const doc of src.find({}, { batchSize: BATCH })) {
    batch.push(doc);
    if (batch.length === BATCH) {
      await dst.insertMany(batch, { ordered: false });
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length) { await dst.insertMany(batch, { ordered: false }); count += batch.length; }
  if (count === 0) await dstDb.createCollection(name).catch(() => {}); // keep empty collections too

  const indexes = (await src.listIndexes().toArray())
    .filter((ix) => ix.name !== '_id_')
    .map((ix) => Object.fromEntries(Object.entries(ix).filter(([k]) => !INDEX_NOISE.includes(k))));
  if (indexes.length) await dst.createIndexes(indexes);
  return { count, indexes: indexes.length };
};

const main = async () => {
  const source = readUri('.env');
  const target = readUri('.env.offline');
  assertCopyTargets(source, target);

  const sourceName = getMongoDbName(source);
  const targetName = getMongoDbName(target);
  console.log(`Copying live database "${sourceName}" -> local "${targetName}" on this machine`);

  let src;
  let dst;
  try {
    src = await mongoose.createConnection(source, { serverSelectionTimeoutMS: 20_000 }).asPromise();
  } catch (err) {
    throw new Error(`Could not reach the live database (is the internet on?): ${err.message}`);
  }
  try {
    dst = await mongoose.createConnection(target, { serverSelectionTimeoutMS: 5_000 }).asPromise();
  } catch (err) {
    await src.close();
    throw new Error(`Could not reach local MongoDB at 127.0.0.1:27017 (is the MongoDB service running?): ${err.message}`);
  }

  try {
    const collections = (await src.db.listCollections({}, { nameOnly: false }).toArray())
      .filter((c) => c.type === 'collection' && !c.name.startsWith('system.'))
      .map((c) => c.name)
      .sort();
    await dst.db.dropDatabase();
    let total = 0;
    for (const name of collections) {
      const { count, indexes } = await copyCollection(src.db, dst.db, name);
      total += count;
      console.log(`  ${name.padEnd(22)} ${String(count).padStart(7)} documents, ${indexes} indexes`);
    }
    console.log(`\nDone: ${collections.length} collections, ${total} documents. Sign in offline with the same accounts as on the live site.`);
  } finally {
    await Promise.allSettled([src.close(), dst.close()]);
  }
};

// Run only when executed directly (`npm run offline:copy`), not when imported by tests (same check as seedAdmin.js).
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isDirectRun()) {
  main().catch((err) => { console.error(`\nCopy failed: ${err.message}`); process.exit(1); });
}
