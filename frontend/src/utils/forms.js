/**
 * @file src/utils/forms.js
 * @description Small helpers shared by the Phase 7 forms.
 *   - getNestedError: react-hook-form stores errors for dotted names
 *     ("scoreThresholds.mediumMin") as nested objects (C-P7-06).
 *   - stripBlank: the API rejects optional string fields that are present but
 *     empty (HTTP 422 "cannot be an empty string"), so blank values are removed
 *     before the payload is sent.
 *   - isValidEmail / isValidName: the same practical rules express-validator applies on the
 *     server (N-16), so the form rejects what the API would answer with a 422.
 */

// Practical subset of validator.js isEmail: dot-atom local part (no leading, trailing or
// consecutive dots), dotted domain of valid labels, alphabetic TLD of 2+ letters.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** @param {unknown} value @returns {boolean} */
export const isValidEmail = (value) =>
  typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());

/** Name rule shared by Register and Profile: 2–100 characters after trimming. */
export const NAME_MIN = 2;
export const NAME_MAX = 100;
/** @param {unknown} value @returns {true|string} RHF `validate` result */
export const validateName = (value) => {
  const len = String(value ?? '').trim().length;
  if (len === 0) return 'Name is required';
  if (len < NAME_MIN) return `Name must be at least ${NAME_MIN} characters`;
  if (len > NAME_MAX) return `Name cannot exceed ${NAME_MAX} characters`;
  return true;
};

/**
 * bcrypt only uses the first 72 BYTES of a password and the server rejects more
 * (non-English characters take 2–4 bytes each). RHF `validate` rule.
 * @param {unknown} value @returns {true|string}
 */
export const PASSWORD_MAX_BYTES = 72;
export const validatePasswordBytes = (value) => {
  const text = String(value ?? '');
  if (new TextEncoder().encode(text).length <= PASSWORD_MAX_BYTES) return true;
  // The limit is in bytes: accented / non-Latin characters use more than one.
  return text.length > PASSWORD_MAX_BYTES
    ? `Password cannot exceed ${PASSWORD_MAX_BYTES} characters`
    : `Password is too long: the limit is ${PASSWORD_MAX_BYTES} bytes and accented or non-Latin characters count as more than one`;
};

/**
 * @param {object} errors  RHF formState.errors
 * @param {string} name    field name, dotted for nested fields
 */
export const getNestedError = (errors, name) =>
  name.split('.').reduce((obj, key) => obj?.[key], errors);

/**
 * Recursively drop empty-string / null / undefined values and empty objects.
 * @param {*} value
 * @returns {*} cleaned copy (undefined when nothing is left)
 */
export function stripBlank(value) {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? undefined : t;
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripBlank(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value ?? undefined;
}
