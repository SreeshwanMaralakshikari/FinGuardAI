/**
 * @file src/utils/common.js
 * @description Single source of truth for all Tailwind className strings.
 *   No JSX file may contain a hardcoded Tailwind class string — import from here.
 *   Tailwind v4 scans this file automatically, so every complete class string
 *   below is generated (no safelist — AUD-14; theme tokens live in src/index.css).
 *
 *   Includes:
 *   - RISK_COLORS          — risk level badge classes (LOW/MEDIUM/HIGH/CRITICAL)
 *   - CASE_STATUS_COLORS   — case status badge classes
 *   - TX_STATUS_COLORS     — transaction status badge classes (APPROVED/HELD/BLOCKED)
 *   - NOTIFICATION_COLORS  — notification type icon classes (FRAUD_ALERT/CASE_ASSIGNED/CASE_STATUS_CHANGED)
 *   - BTN                  — button variants
 *   - CARD                 — card container classes
 *   - INPUT                — form input classes
 *   - TABLE                — table element classes
 *   - BADGE                — base badge classes
 *   - formatCurrency()     — ₹ Indian Rupee, en-IN locale
 *   - formatDate()         — "07 Sept 2026, 10:30 am" Asia/Kolkata
 *   - formatDateShort()    — "07 Sept 2026"
 *   - truncate()           — truncate string to n characters
 *   - getInitials()        — "Sreeshwan M" → "SM"
 *
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-07, D-P6-10, D-P6-15, D-P6-16, D-P6-21
 */

// ─── Risk Level Classes ───────────────────────────────────────────────────────
// Matches fraudDetectionService riskLevel output: LOW | MEDIUM | HIGH | CRITICAL

export const RISK_COLORS = Object.freeze({
  LOW: Object.freeze({
    text:   'text-emerald-700',
    bg:     'bg-emerald-100',
    border: 'border-emerald-300',
  }),
  MEDIUM: Object.freeze({
    text:   'text-yellow-800',
    bg:     'bg-yellow-100',
    border: 'border-yellow-300',
  }),
  HIGH: Object.freeze({
    text:   'text-orange-800',
    bg:     'bg-orange-100',
    border: 'border-orange-300',
  }),
  CRITICAL: Object.freeze({
    text:   'text-red-700',
    bg:     'bg-red-100',
    border: 'border-red-300',
  }),
});

// ─── Case Status Classes ──────────────────────────────────────────────────────
// Matches Phase 3 FraudCase status enum: OPEN | ASSIGNED | UNDER_REVIEW | RESOLVED | DISMISSED

export const CASE_STATUS_COLORS = Object.freeze({
  OPEN: Object.freeze({
    text:   'text-blue-700',
    bg:     'bg-blue-100',
    border: 'border-blue-300',
  }),
  ASSIGNED: Object.freeze({
    text:   'text-purple-700',
    bg:     'bg-purple-100',
    border: 'border-purple-300',
  }),
  UNDER_REVIEW: Object.freeze({
    text:   'text-indigo-700',
    bg:     'bg-indigo-100',
    border: 'border-indigo-300',
  }),
  RESOLVED: Object.freeze({
    text:   'text-green-700',
    bg:     'bg-green-100',
    border: 'border-green-300',
  }),
  DISMISSED: Object.freeze({
    text:   'text-gray-600',
    bg:     'bg-gray-100',
    border: 'border-gray-300',
  }),
});

// ─── Transaction Status Classes ───────────────────────────────────────────────
// Matches Phase 3 TransactionModel.status enum: APPROVED | HELD | BLOCKED
// C-P6-08: corrected from incorrect PENDING/COMPLETED/FLAGGED/REVERSED keys

export const TX_STATUS_COLORS = Object.freeze({
  APPROVED: Object.freeze({
    text:   'text-green-700',
    bg:     'bg-green-100',
    border: 'border-green-300',
  }),
  HELD: Object.freeze({
    text:   'text-amber-700',
    bg:     'bg-amber-100',
    border: 'border-amber-300',
  }),
  BLOCKED: Object.freeze({
    text:   'text-red-700',
    bg:     'bg-red-100',
    border: 'border-red-300',
  }),
});

// ─── Notification Type Icon Classes ──────────────────────────────────────────
// Matches Phase 3 NotificationModel.type enum: FRAUD_ALERT | CASE_ASSIGNED | CASE_STATUS_CHANGED
// C-P6-10: corrected from incorrect FRAUD_ALERT/TRANSACTION_UPDATE/CASE_UPDATE/SYSTEM keys

export const NOTIFICATION_COLORS = Object.freeze({
  FRAUD_ALERT:          { icon: 'text-rose-600'   },
  CASE_ASSIGNED:        { icon: 'text-sky-600'    },
  CASE_STATUS_CHANGED:  { icon: 'text-purple-700' },
});

// ─── Button Variants ──────────────────────────────────────────────────────────

export const BTN = Object.freeze({
  base:      'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
  primary:   'bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500',
  secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:ring-primary-500',
  danger:    'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  ghost:     'text-gray-600 hover:bg-gray-100 focus:ring-gray-400',
  sm:        'px-3 py-1.5 text-sm gap-1.5',
  md:        'px-4 py-2 text-sm gap-2',
  lg:        'px-6 py-3 text-base gap-2',
});

// ─── Card ─────────────────────────────────────────────────────────────────────

export const CARD = Object.freeze({
  base:    'bg-white rounded-xl border border-gray-200 shadow-sm',
  body:    'p-6',
  header:  'px-6 py-4 border-b border-gray-100',
  footer:  'px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-xl',
});

// ─── Form Inputs ──────────────────────────────────────────────────────────────

export const INPUT = Object.freeze({
  base:    'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500',
  error:   'border-red-400 focus:border-red-500 focus:ring-red-400',
  label:   'block text-sm font-medium text-gray-700 mb-1',
  errMsg:  'mt-1 text-xs text-red-600',
  select:  'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500',
});

// ─── Table ────────────────────────────────────────────────────────────────────

export const TABLE = Object.freeze({
  wrapper: 'overflow-x-auto rounded-xl border border-gray-200',
  table:   'min-w-full divide-y divide-gray-200',
  thead:   'bg-gray-50',
  th:      'px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider',
  tbody:   'divide-y divide-gray-100 bg-white',
  td:      'px-3 py-3 text-sm text-gray-700 whitespace-nowrap',
  tr:      'hover:bg-gray-50 transition-colors',
});

// ─── Badge ────────────────────────────────────────────────────────────────────

export const BADGE = Object.freeze({
  base: 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border',
});

// ─── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format a number as Indian Rupee currency.
 * @param {number} amount
 * @returns {string} e.g. "₹1,23,456.00"
 */
export function formatCurrency(amount) {
  if (amount == null || isNaN(amount)) return '₹0.00';
  return new Intl.NumberFormat('en-IN', {
    style:                 'currency',
    currency:              'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format an ISO date string to "07 Sept 2026, 10:30 am" (Asia/Kolkata).
 * @param {string|Date} isoDate
 * @returns {string}
 */
export function formatDate(isoDate) {
  if (!isoDate || Number.isNaN(new Date(isoDate).getTime())) return '—'; // FE-fix: invalid input must not throw
  return new Intl.DateTimeFormat('en-IN', {
    day:      '2-digit',
    month:    'short',
    year:     'numeric',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   true,
    timeZone: 'Asia/Kolkata',
  }).format(new Date(isoDate));
}

/**
 * Format an ISO date string to "07 Sept 2026" (date only, Asia/Kolkata).
 * @param {string|Date} isoDate
 * @returns {string}
 */
export function formatDateShort(isoDate) {
  if (!isoDate || Number.isNaN(new Date(isoDate).getTime())) return '—'; // FE-fix: invalid input must not throw
  return new Intl.DateTimeFormat('en-IN', {
    day:      '2-digit',
    month:    'short',
    year:     'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(isoDate));
}

/**
 * Truncate a string to n characters, appending "…" if truncated.
 * @param {string} str
 * @param {number} [n=60]
 * @returns {string}
 */
export function truncate(str, n = 60) {
  if (!str) return '';
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Extract initials from a full name (up to 2 characters).
 * @param {string} name — e.g. "Sreeshwan M"
 * @returns {string} — e.g. "SM"
 */
export function getInitials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * Build badge className string from a color map entry and BADGE.base.
 * @param {{ text: string, bg: string, border: string }} colorEntry
 * @returns {string}
 */
export function badgeClass(colorEntry) {
  if (!colorEntry) return BADGE.base;
  return `${BADGE.base} ${colorEntry.bg} ${colorEntry.text} ${colorEntry.border}`;
}

// ─── Server Wake Gate (Phase 9) ───────────────────────────────────────────────
// Used by components/common/ServerWakeGate.jsx while the Render free-tier
// instance is cold-starting. Static strings — found by Tailwind's source scan.

export const WAKE_GATE = Object.freeze({
  screen:   'flex min-h-screen items-center justify-center bg-gray-50 px-4',
  card:     'w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm',
  spinner:  'mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-4 border-primary-600 border-t-transparent',
  title:    'text-lg font-semibold text-gray-900',
  text:     'mt-2 text-sm text-gray-600',
  meta:     'mt-4 text-xs font-medium text-gray-500',
  srOnly:   'sr-only',
  errorIcon:'mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-lg font-bold text-red-600',
  button:   'mt-6 inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
});
