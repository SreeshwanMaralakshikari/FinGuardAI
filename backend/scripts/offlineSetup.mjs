/**
 * @file scripts/offlineSetup.mjs
 * @description Creates backend/.env.offline: the settings for running the WHOLE app on this laptop without
 *   internet (local MongoDB + local ML service + local website). Your normal .env (Atlas) is not touched.
 *
 *     npm run offline:setup            creates .env.offline (does nothing if it already exists)
 *     npm run offline:setup -- --force replaces it with a new one (new secrets: sign in again afterwards)
 *
 *   The admin login and the analyst invite code are copied from .env, so offline you sign in exactly as on
 *   the live site. Without a .env, a local admin with a random password is created and printed once.
 *   Everything else (JWT secret, ML key) is generated here and only ever used on this laptop.
 *
 *   The offline scripts start Node with `--env-file=.env.offline`. Node sets those values first; the app's
 *   dotenv step then reads .env but never overrides a value that is already set, so .env only fills in what
 *   .env.offline leaves out (the Cloudinary keys, used only for profile-picture uploads, which need internet).
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(BACKEND, '.env.offline');
const SOURCE = join(BACKEND, '.env');

export const OFFLINE_DB_URI = 'mongodb://127.0.0.1:27017/finguardai_offline';
export const OFFLINE_ML_URL = 'http://127.0.0.1:5001';

const hex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * Text of a new .env.offline. Pure apart from the random secrets, so it is testable.
 * @param {Record<string,string>} live  values parsed from .env ({} when there is none)
 * @returns {{ text: string, generatedAdmin: null | { email: string, password: string } }}
 */
export const buildOfflineEnv = (live = {}) => {
  const hasAdmin = Boolean(live.ADMIN_EMAIL?.trim() && live.ADMIN_PASSWORD);
  const generatedAdmin = hasAdmin ? null : { email: 'admin@finguard.local', password: `Admin-${hex(6)}` };
  const invite = (live.ANALYST_INVITE_CODE ?? '').trim().length >= 8 ? live.ANALYST_INVITE_CODE.trim() : `invite-${hex(6)}`;
  // Single quotes are literal in both dotenv and Node's --env-file (no escapes, no # comments), so a password
  // with spaces, #, " or \ survives. A value that itself contains ' falls back to double quotes.
  const quote = (v) => {
    if (!v.includes("'")) return `'${v}'`;
    if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
    throw new Error('A value in .env mixes quote characters that cannot be written safely; type it by hand into .env.offline');
  };

  const lines = [
    '# FinGuardAI offline settings: the whole app on this laptop, no internet needed.',
    '# Created by `npm run offline:setup`. Used by the *:offline npm scripts and start-offline.cmd.',
    '# Never commit this file (it is git-ignored). Secrets here are local-only and different from Render.',
    '',
    'NODE_ENV=development',
    'PORT=5000',
    `MONGODB_URI=${OFFLINE_DB_URI}`,
    `JWT_SECRET=${hex(48)}`,
    'FRONTEND_URL=http://localhost:3000',
    '',
    '# Same logins as the live site (copied from .env), so nothing new to remember.',
    `ADMIN_EMAIL=${quote(hasAdmin ? live.ADMIN_EMAIL.trim() : generatedAdmin.email)}`,
    `ADMIN_NAME=${quote((live.ADMIN_NAME ?? '').trim() || 'FinGuardAI Admin')}`,
    `ADMIN_PASSWORD=${quote(hasAdmin ? live.ADMIN_PASSWORD : generatedAdmin.password)}`,
    `ANALYST_INVITE_CODE=${quote(invite)}`,
    '',
    '# Local ML service (start-offline.cmd starts it with this same key).',
    'ML_ENABLED=true',
    `ML_SERVICE_URL=${OFFLINE_ML_URL}`,
    `ML_API_KEY=${hex(32)}`,
    '',
    '# Where `npm run seed:demo:offline` sends its requests.',
    'API_URL=http://127.0.0.1:5000',
    '',
  ];
  return { text: lines.join('\n'), generatedAdmin };
};

const main = () => {
  const force = process.argv.includes('--force');
  if (existsSync(TARGET) && !force) {
    console.log('backend/.env.offline already exists; nothing changed. (Use `npm run offline:setup -- --force` to make a new one.)');
    return;
  }
  const live = existsSync(SOURCE) ? dotenv.parse(readFileSync(SOURCE)) : {};
  const { text, generatedAdmin } = buildOfflineEnv(live);
  writeFileSync(TARGET, text, { encoding: 'utf8', mode: 0o600 });

  console.log('Created backend/.env.offline');
  console.log(`  database   ${OFFLINE_DB_URI}`);
  console.log(`  ML service ${OFFLINE_ML_URL}`);
  if (generatedAdmin) {
    console.log(`  No admin found in .env, so a local one was made: ${generatedAdmin.email} / ${generatedAdmin.password}`);
    console.log('  (Write it down; it is also in backend/.env.offline.)');
  } else {
    console.log('  Admin login and analyst invite code: the same as in your .env');
  }
  console.log('\nNext: npm run offline:copy   (copy the live data, needs internet once)');
  console.log('  or: npm run seed:admin:offline, then start the app and run npm run seed:demo:offline (fresh demo data)');
};

// Run only when executed directly (`npm run offline:setup`), not when imported by tests (same check as seedAdmin.js).
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isDirectRun()) main();
