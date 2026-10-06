/**
 * @file seed/seedAdmin.js
 * @description One-off seeding script — run from your machine, never on Render:
 *     npm run seed:admin
 *   1. Creates the single ADMIN account from ADMIN_EMAIL / ADMIN_PASSWORD
 *      if no user with that email exists (ADMIN can't self-register — D-P8-03).
 *   2. Upserts the SystemConfig singleton with schema defaults using
 *      $setOnInsert (Phase 3 seeding note) — idempotent: thresholds already
 *      customised by the admin are never overwritten.
 *   Exits 0 on success, 1 on failure.
 *
 *   Safety checks (fix round):
 *     • D-04  MONGODB_URI must name a database (Atlas "Connect" strings do not)
 *     • D-10  against production / a non-local database the password must be
 *             ≥ 12 characters and not the .env.example placeholder
 *     • D-10  if the email already exists with a role other than ADMIN
 *             (someone registered it first) the script FAILS (exit 1) instead
 *             of pretending the admin exists
 * @phase Phase 2 spec / Phase 3 seeding note → implementation recorded in the Phase 1–9 audit
 */
import '../config/loadEnv.js'; // ⚠️ keep first — loads .env before anything reads process.env

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import UserModel from '../models/UserModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import { getMongoDbName, isLocalMongoUri } from '../config/mongoUri.js';

const MIN_PASSWORD_LENGTH = 8;
const MIN_STRONG_PASSWORD_LENGTH = 12;
const PLACEHOLDER_PASSWORDS = ['change-me-strong-password'];

/**
 * Validates the seed configuration. Pure (reads only `env`), so it is unit-testable.
 * @param {Record<string, string|undefined>} env
 * @returns {{ warnings: string[] }}  throws Error on any fatal problem
 */
export const assertSeedConfig = (env = process.env) => {
  const { MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD } = env;
  const warnings = [];

  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  if (ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  // Seeding a production-like target: be strict.
  const strict = env.NODE_ENV === 'production' || !isLocalMongoUri(MONGODB_URI);

  if (!getMongoDbName(MONGODB_URI)) {
    const message = 'MONGODB_URI has no database name (…mongodb.net/<dbname>?…) — the user would be created in "test"';
    if (strict) throw new Error(message);
    warnings.push(message);
  }

  if (strict) {
    if (PLACEHOLDER_PASSWORDS.includes(ADMIN_PASSWORD)) {
      throw new Error('ADMIN_PASSWORD is still the placeholder from .env.example — choose a strong password');
    }
    if (ADMIN_PASSWORD.length < MIN_STRONG_PASSWORD_LENGTH) {
      throw new Error(`ADMIN_PASSWORD must be at least ${MIN_STRONG_PASSWORD_LENGTH} characters for a production/remote database`);
    }
  }

  return { warnings };
};

export const seed = async () => {
  const { warnings } = assertSeedConfig(process.env);
  for (const warning of warnings) console.warn(`[seed] WARNING: ${warning}`);

  const { MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  const adminName = process.env.ADMIN_NAME ?? 'FinGuardAI Admin';

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  console.log(`[seed] Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  // Emails are stored lowercase (UserModel lowercase: true)
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const existing = await UserModel.findOne({ email });
  if (existing && existing.role !== 'ADMIN') {
    // D-10: someone registered this address first through open registration.
    throw new Error(
      `${email} already exists with role ${existing.role}, not ADMIN — no admin was created. ` +
      'Use a different ADMIN_EMAIL or remove/repair that account first.'
    );
  }
  if (existing) {
    console.log(`[seed] ADMIN ${email} already exists — not modified`);
  } else {
    // create() runs the pre-save hook → password hashed with bcrypt cost 12
    await UserModel.create({ name: adminName, email, password: ADMIN_PASSWORD, role: 'ADMIN' });
    console.log(`[seed] ADMIN created: ${email}`);
  }

  const config = await SystemConfigModel.findOneAndUpdate(
    { singleton: 'system' },
    { $setOnInsert: { singleton: 'system' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  console.log(`[seed] SystemConfig ready (amountThreshold ₹${config.amountThreshold}, ` +
    `score bands ${config.scoreThresholds.mediumMin}/${config.scoreThresholds.highMin}/${config.scoreThresholds.criticalMin})`);
};

// Run only when executed directly (`npm run seed:admin`), not when imported by tests.
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    // realpath: the script may be started through a symlinked path
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isDirectRun()) {
  seed()
    .then(async () => {
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[seed] Failed:', err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}
