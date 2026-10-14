/**
 * @file src/utils/demoLogins.js
 * @description R4-05: one-click demo sign-in on the login page — OFF unless the build sets VITE_DEMO_LOGINS=true.
 *   Only a demo CUSTOMER and a demo ANALYST (accounts created by `npm run seed:demo` in the backend); never an
 *   admin, because anyone who opens the site could then change thresholds or deactivate users.
 *   The password is the seed script's DEMO_PASSWORD (default "Demo@12345"). VITE_* values are public (they
 *   are inlined into the JavaScript bundle), so these must be throw-away demo accounts only.
 */
const env = import.meta.env;

export const DEMO_LOGINS_ENABLED = String(env.VITE_DEMO_LOGINS ?? '').trim().toLowerCase() === 'true';
const PASSWORD = String(env.VITE_DEMO_PASSWORD ?? '').trim() || 'Demo@12345';

export const DEMO_ACCOUNTS = Object.freeze([
  { key: 'customer', label: 'Try as a customer', email: 'demo.aarav@example.com', password: PASSWORD },
  { key: 'analyst', label: 'Try as a fraud analyst', email: 'demo.priya@example.com', password: PASSWORD },
]);
