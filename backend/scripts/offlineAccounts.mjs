/**
 * @file scripts/offlineAccounts.mjs
 * @description Lists every account in the OFFLINE database, and can set a new password for one of them.
 *   Works only on a database on this machine (the offline copy), never on Atlas.
 *
 *     npm run offline:accounts
 *         every account: role, name, email, active, and where its password comes from
 *     node --env-file=.env.offline scripts/offlineAccounts.mjs reset 'someone@example.com' 'New-Pass-123'
 *         new password for that account in the OFFLINE copy only (the live site keeps the old one)
 *
 *   Passwords are stored as bcrypt hashes, so they can never be read back, only replaced.
 *   The admin password is not printed (terminal output gets copied around): it is ADMIN_PASSWORD in
 *   backend/.env.offline, unless it was changed in the app after copying.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import UserModel from '../models/UserModel.js';
import { isLocalMongoUri, getMongoDbName } from '../config/mongoUri.js';

export const DEMO_PASSWORD = 'Demo@12345';
const DEMO_EMAIL = /^demo\.[a-z]+@example\.com$/;
const ROLE_ORDER = ['ADMIN', 'ANALYST', 'CUSTOMER'];

/** Where an account's password comes from (never the password itself, except the public demo one). */
export const passwordHint = (user, adminEmail = '') => {
  if (user.role === 'ADMIN' && adminEmail && user.email === adminEmail.trim().toLowerCase()) {
    return 'ADMIN_PASSWORD in backend/.env.offline';
  }
  if (DEMO_EMAIL.test(user.email)) return `${DEMO_PASSWORD} (demo account)`;
  return 'the one chosen at sign-up (forgotten? use reset)';
};

/** Same rules as the app's sign-up form (8+ characters, at most 72 bytes, not only spaces). */
export const checkNewPassword = (password) => {
  if (typeof password !== 'string' || password.length < 8) return 'The new password must be at least 8 characters.';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'The new password must be at most 72 bytes.';
  if (!password.trim()) return 'The new password cannot be only spaces.';
  return null;
};

const connectLocal = async () => {
  const uri = (process.env.MONGODB_URI ?? '').trim();
  if (!uri) throw new Error('MONGODB_URI is not set. Run this with --env-file=.env.offline (or use npm run offline:accounts).');
  if (!isLocalMongoUri(uri)) throw new Error('This tool only works on the offline database on this machine, never on Atlas.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
  return getMongoDbName(uri);
};

const list = async () => {
  const dbName = await connectLocal();
  const users = await UserModel.find({}).select('name email role isActive').lean();
  users.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.email.localeCompare(b.email));
  console.log(`Accounts in the offline database "${dbName}" (${users.length}):\n`);
  const emailWidth = Math.max(10, ...users.map((u) => u.email.length)) + 2;
  const nameWidth = Math.max(4, ...users.map((u) => String(u.name ?? '').length)) + 2;
  for (const role of ROLE_ORDER) {
    const group = users.filter((u) => u.role === role);
    if (!group.length) continue;
    console.log(`${role} (${group.length})`);
    for (const u of group) {
      const status = u.isActive === false ? '  [deactivated]' : '';
      console.log(`  ${u.email.padEnd(emailWidth)}${String(u.name ?? '').padEnd(nameWidth)}password: ${passwordHint(u, process.env.ADMIN_EMAIL)}${status}`);
    }
    console.log('');
  }
  console.log("Forgot one? node --env-file=.env.offline scripts/offlineAccounts.mjs reset 'email' 'New-Password'");
  console.log('(changes the offline copy only; the live site keeps its password)');
};

const reset = async (email, password) => {
  if (!email || password === undefined) throw new Error("Usage: node --env-file=.env.offline scripts/offlineAccounts.mjs reset 'email' 'New-Password'");
  const problem = checkNewPassword(password);
  if (problem) throw new Error(problem);
  await connectLocal();
  const user = await UserModel.findOne({ email: email.trim().toLowerCase() }).select('+password');
  if (!user) throw new Error(`No account with the email ${email} in the offline database. Run npm run offline:accounts to see them all.`);
  user.password = password; // hashed by the model's pre-save hook, exactly like a sign-up
  await user.save();
  console.log(`New password set for ${user.email} (${user.role}) in the offline database. The live site is unchanged.`);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (!command || command === 'list') await list();
    else if (command === 'reset') await reset(...rest);
    else throw new Error(`Unknown command "${command}". Use "list" or "reset".`);
  } finally {
    await mongoose.disconnect();
  }
};

// Run only when executed directly, not when imported by tests (same check as seedAdmin.js).
const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (isDirectRun()) {
  main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
}
