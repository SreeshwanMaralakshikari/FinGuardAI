/**
 * @file config/db.js
 * @description MongoDB Atlas connection via Mongoose.
 *   - Resolves only after the connection is open, so server.js can await it
 *     before calling listen() (no requests are served without a database).
 *   - serverSelectionTimeoutMS: fail in 10 s with a readable error instead of
 *     hanging if the Atlas IP access list blocks Render.
 *   - Logs disconnect / reconnect events so they are visible in Render logs.
 * @phase Phase 9 — Deployment (production hardening of the Phase 2 file)
 */
import mongoose from 'mongoose';

const connectDB = async () => {
  mongoose.connection.on('disconnected', () => console.warn('[DB] MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[DB] MongoDB reconnected'));
  mongoose.connection.on('error', (err) => console.error('[DB] MongoDB error:', err.message));

  const conn = await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
  });

  console.log(`[DB] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  return conn;
};

/**
 * E-17: Mongoose builds indexes in the background after connecting and nothing reports a
 * failure. A unique index (e.g. one case per alert, one alert per transaction) fails to build
 * when the collection already holds duplicates, or when an index with the same key but other
 * options exists — and the guarantee is then silently missing. Wait for every model's index
 * build and log each failure with the model name. Never throws and never exits: the API stays
 * up, the operator sees the problem in the logs.
 * @param {Record<string, { init: () => Promise<unknown> }>} [models]  defaults to mongoose.models
 * @returns {Promise<{ model: string, error: Error }[]>} the failures (empty = all indexes are in place)
 */
export const ensureIndexes = async (models = mongoose.models) => {
  const entries = Object.entries(models);
  const results = await Promise.allSettled(entries.map(([, model]) => model.init()));
  const failures = [];
  results.forEach((result, i) => {
    if (result.status !== 'rejected') return;
    const [name] = entries[i];
    const error = result.reason;
    const hint = error?.code === 11000
      ? 'duplicate values already exist — remove the duplicates, then restart or run `npm run db:sync-indexes`'
      : [85, 86].includes(error?.code)
        ? 'an index with the same key but different options exists — drop the old index (run `npm run db:sync-indexes`), then restart'
        : 'see the message above; `npm run db:sync-indexes` re-applies the schema indexes';
    console.error(`[DB] Index build FAILED for model ${name}: ${error?.message ?? error} (${hint})`);
    failures.push({ model: name, error });
  });
  return failures;
};

/** Close the connection — used by graceful shutdown in server.js */
export const disconnectDB = () => mongoose.connection.close(false);

export default connectDB;
