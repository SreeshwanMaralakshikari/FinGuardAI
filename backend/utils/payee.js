/**
 * @file utils/payee.js
 * @description TEJAS D1: who receives the money. Pure helpers (no imports from models or services),
 *   shared by the validator, the submit pipeline, the watchlist and the tests.
 *
 *   Every payment has a payee key:
 *     • "vpa:<upi id>"            when the customer entered the payee's UPI ID (e.g. vpa:ravi.k@okaxis);
 *     • "merchant:<merchant name>" otherwise (older payments, cards, net banking without a UPI ID).
 *   The prefix keeps the two kinds apart, so a merchant called "ravi@okaxis" can never collide with that UPI ID.
 *   Both parts are compared case-insensitively and with inner spaces collapsed, like cities (normalizeCity).
 */

/**
 * A UPI ID (virtual payment address): "<handle>@<provider>".
 *   handle:   2–64 of letters, digits, ".", "-", "_" (NPCI allows these), starting with a letter or digit;
 *   provider: 2–32 letters (okaxis, ybl, paytm, upi, …).
 * Deliberately simple: the app validates the SHAPE of a UPI ID; it never contacts a bank to resolve it.
 */
export const VPA_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z]{2,32}$/;

/** Longest accepted UPI ID (64 + 1 + 32 = 97; the validator caps the raw input at 100 characters). */
export const VPA_MAX_LENGTH = 100;

/** Prefixes of the two kinds of payee key. */
export const PAYEE_KEY_PREFIX = Object.freeze({ VPA: 'vpa:', MERCHANT: 'merchant:' });

/**
 * UPI ID comparison form: Unicode NFKC, trimmed, lower-case. Returns '' for anything that is not a string.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeVpa = (value) =>
  (typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '');

/** @returns {boolean} whether `value` (after normalizeVpa) is a well-formed UPI ID */
export const isValidVpa = (value) => VPA_PATTERN.test(normalizeVpa(value));

/**
 * Merchant comparison form: NFKC, trimmed, inner whitespace collapsed, lower-case.
 * "  Gadget   Hub " and "gadget hub" are the same payee.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeMerchantName = (value) =>
  String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The payee of one payment.
 * @param {{ payeeVpa?: string, merchantName?: string }} input  validated request fields
 * @returns {{ key: string, vpa?: string }}  `vpa` only when a valid UPI ID was given
 */
export const buildPayee = ({ payeeVpa, merchantName } = {}) => {
  const vpa = normalizeVpa(payeeVpa);
  if (vpa && VPA_PATTERN.test(vpa)) return { key: `${PAYEE_KEY_PREFIX.VPA}${vpa}`, vpa };
  return { key: `${PAYEE_KEY_PREFIX.MERCHANT}${normalizeMerchantName(merchantName)}` };
};

/**
 * Is `key` a well-formed payee key? Used by the analyst routes, so a query such as ?key[$ne]= or a
 * random string can never reach a database filter.
 * @param {unknown} key
 * @returns {boolean}
 */
export const isPayeeKey = (key) => {
  if (typeof key !== 'string' || key.length > 220) return false;
  if (key.startsWith(PAYEE_KEY_PREFIX.VPA)) return VPA_PATTERN.test(key.slice(PAYEE_KEY_PREFIX.VPA.length));
  if (key.startsWith(PAYEE_KEY_PREFIX.MERCHANT)) {
    const name = key.slice(PAYEE_KEY_PREFIX.MERCHANT.length);
    return name.length > 0 && name === normalizeMerchantName(name);
  }
  return false;
};

/**
 * Text shown for a payee: the UPI ID, or the merchant name as the customer typed it.
 * @param {{ payee?: { vpa?: string }, merchantName?: string }} transaction
 * @returns {string}
 */
export const payeeLabel = (transaction) => transaction?.payee?.vpa || transaction?.merchantName || 'Unknown payee';
