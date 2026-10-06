/**
 * @file utils/normalize.js
 * @description Pure text helpers shared by the fraud rules, the behaviour
 *   profile and the validators, so both sides of every comparison are
 *   normalised the same way (L-15). No imports: safe for the pure fraud engine.
 */

/**
 * Merchant category key: upper-case, every character except A–Z, 0–9 and "_"
 * removed. "CASI NO", "casino" and " Casino " all map to the same key as the
 * stored "CASINO"; "CRYPTO_EXCHANGE" keeps its underscore.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeCategory = (value) =>
  String(value ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '');

/**
 * City comparison key: trimmed, inner whitespace collapsed, case-insensitive.
 * The original spelling is still what gets stored and displayed.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeCity = (value) =>
  String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Indian digit grouping for ₹ amounts, independent of the server's locale
 * (en-IN, at most 2 decimals): 1250000 → "12,50,000", 13666.6667 → "13,666.67".
 * @param {number} amount
 * @returns {string}
 */
export const formatRupees = (amount) =>
  Number(amount ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
