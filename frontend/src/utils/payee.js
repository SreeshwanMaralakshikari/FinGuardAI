/**
 * @file src/utils/payee.js
 * @description TEJAS D1: payee helpers for the UI. The rules are a copy of backend/utils/payee.js
 *   (the same pattern, normalisation and key format), so the form rejects exactly what the API rejects and a
 *   payee typed on the analyst pages finds the same key the backend stored. A test pins both copies to the same
 *   examples.
 */

/** "<handle>@<provider>": handle 2–64 of [a-z0-9._-] starting with a letter or digit; provider 2–32 letters. */
export const VPA_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z]{2,32}$/;
export const VPA_MAX_LENGTH = 100;
export const VPA_MESSAGE = 'Enter a UPI ID like name@bank (letters, digits, ".", "-" or "_" before the @)';

/** NFKC, trimmed, lower-case; '' for anything that is not a string. */
export const normalizeVpa = (value) =>
  (typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '');

export const isValidVpa = (value) => VPA_PATTERN.test(normalizeVpa(value));

/** NFKC, trimmed, inner whitespace collapsed, lower-case. */
export const normalizeMerchantName = (value) =>
  String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The payee key for what an analyst typed: text with an "@" is a UPI ID, anything else a merchant name.
 * @param {string} text
 * @returns {{ key: string, kind: 'vpa'|'merchant' } | { error: string }}
 */
export const payeeKeyFromInput = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw) return { error: 'Enter a UPI ID or a merchant name' };
  if (raw.includes('@')) {
    const vpa = normalizeVpa(raw);
    return VPA_PATTERN.test(vpa) ? { key: `vpa:${vpa}`, kind: 'vpa' } : { error: VPA_MESSAGE };
  }
  const name = normalizeMerchantName(raw);
  if (name.length > 200) return { error: 'Merchant name cannot exceed 200 characters' };
  return { key: `merchant:${name}`, kind: 'merchant' };
};

/** Link to the analyst payee profile for a stored payee key. */
export const payeeProfilePath = (key) => `/analyst/payees?key=${encodeURIComponent(key)}`;

/** Text shown for the payee of a transaction: its UPI ID, else the merchant name. */
export const payeeLabel = (transaction) => transaction?.payee?.vpa || transaction?.merchantName || 'Unknown payee';

/** Human text for a payee key ("vpa:a@b" → "a@b", "merchant:x" → "x"). */
export const labelFromKey = (key) => String(key ?? '').replace(/^(vpa|merchant):/, '');

/** From this many distinct senders in 24 h a payee is highlighted (shown only; the score is unchanged in step 1). */
export const MANY_SENDERS = 3;

/** The chips that describe the payee, most serious first. */
export function payeeChips(signals) {
  if (!signals) return [];
  const chips = [];
  if (signals.watchlisted) chips.push({ tone: 'danger', text: 'On the payee watchlist' });
  // Many different customers paying one payee within a day is how a mule account collects money.
  if (signals.sendersLast24h >= MANY_SENDERS) chips.push({ tone: 'warn', text: `Paid by ${signals.sendersLast24h} customers in 24 h` });
  if (signals.firstTimePayee) chips.push({ tone: 'warn', text: 'First payment from this customer to this payee' });
  chips.push(signals.payeeAgeDays === 0
    ? { tone: 'warn', text: 'New payee (first paid under a day ago)' }
    : { tone: 'neutral', text: `Payee known for ${signals.payeeAgeDays} day${signals.payeeAgeDays === 1 ? '' : 's'}` });
  return chips;
}


/** Longest note the API accepts on a watchlist entry. */
export const WATCHLIST_NOTE_MAX = 300;

/**
 * What the add form sends: text with an "@" is a UPI ID (validated like the API), anything else a merchant name.
 * @returns {{ body: object } | { error: string }}
 */
export function buildWatchlistBody(payee, note) {
  const text = payee.trim();
  if (!text) return { error: 'Enter a UPI ID or a merchant name' };
  if (note.trim().length > WATCHLIST_NOTE_MAX) return { error: `Note cannot exceed ${WATCHLIST_NOTE_MAX} characters` };
  const extra = note.trim() ? { note: note.trim() } : {};
  if (text.includes('@')) return isValidVpa(text) ? { body: { vpa: normalizeVpa(text), ...extra } } : { error: VPA_MESSAGE };
  if (text.length > 200) return { error: 'Merchant name cannot exceed 200 characters' };
  return { body: { merchantName: text, ...extra } };
}

