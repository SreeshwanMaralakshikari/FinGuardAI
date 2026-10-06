/**
 * @file src/utils/navigation.js
 * @description Sidebar items per role: { to, label, icon, end? }, plus the post-login
 *   redirect rule (N-17).
 */
import { ROLE_HOME } from './constants.js';

export const CUSTOMER_NAV = [
  { to: '/customer',                    label: 'Dashboard',          icon: 'dashboard', end: true },
  { to: '/customer/submit-transaction', label: 'Submit Transaction', icon: 'send' },
  { to: '/customer/transactions',       label: 'Transactions',       icon: 'list' },
  { to: '/customer/fraud-alerts',       label: 'Fraud Alerts',       icon: 'alert' },
  { to: '/customer/trust-score',        label: 'Trust Score',        icon: 'shield' },
  { to: '/customer/profile',            label: 'Profile',            icon: 'user' },
];

export const ANALYST_NAV = [
  { to: '/analyst',                      label: 'Dashboard',            icon: 'dashboard', end: true },
  { to: '/analyst/flagged-transactions', label: 'Flagged Transactions', icon: 'alert' },
  { to: '/analyst/cases',                label: 'Cases',                icon: 'briefcase' },
  { to: '/analyst/fraud-patterns',       label: 'Fraud Patterns',       icon: 'network' },
  { to: '/analyst/device-reputation',    label: 'Device Reputation',    icon: 'device' },
  { to: '/analyst/account',              label: 'Account',              icon: 'user' },
];

export const ADMIN_NAV = [
  { to: '/admin',            label: 'Dashboard',  icon: 'dashboard', end: true },
  { to: '/admin/trends',     label: 'Trends',     icon: 'trend' },
  { to: '/admin/users',      label: 'Users',      icon: 'users' },
  { to: '/admin/simulation', label: 'Simulation', icon: 'play' },
  { to: '/admin/thresholds', label: 'Thresholds', icon: 'sliders' },
  { to: '/admin/audit-logs', label: 'Audit Logs', icon: 'scroll' },
  { to: '/admin/account',    label: 'Account',    icon: 'user' },
];

/**
 * Where to send a user who just signed in (N-17). `from` is the location ProtectedRoute
 * remembered ({ pathname, search?, hash? } or a path string). It is honoured only when it lies
 * inside the signed-in role's own area; anything else (another role's pages, /login, //evil.com)
 * falls back to the role's home.
 * @param {string|undefined} role
 * @param {{ pathname?: string, search?: string, hash?: string }|string|undefined|null} from
 * @returns {string}
 */
export function resolvePostLogin(role, from) {
  const home = ROLE_HOME[role] ?? '/';
  const loc = typeof from === 'string' ? { pathname: from } : from;
  const pathname = loc?.pathname;
  if (typeof pathname !== 'string' || !ROLE_HOME[role]) return home;
  const inArea = pathname === home || pathname.startsWith(`${home}/`);
  return inArea ? `${pathname}${loc.search ?? ''}${loc.hash ?? ''}` : home;
}
