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

/** Close the connection — used by graceful shutdown in server.js */
export const disconnectDB = () => mongoose.connection.close(false);

export default connectDB;
