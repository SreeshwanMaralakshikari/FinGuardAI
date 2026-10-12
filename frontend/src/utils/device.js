/**
 * @file src/utils/device.js
 * @description Stable per-browser device fingerprint for POST /customer-api/transactions.
 *   The API REQUIRES a deviceId and uses it as the "known device" signal: a random id
 *   per request would make every purchase look like a new device (+20 fraud points),
 *   so one id is generated once and kept in localStorage. Storage can be blocked
 *   (private mode) — then the id lives for the current page session only.
 */
const KEY = 'finguard:device-id';
let memoryId = null;

function generate() {
  const rnd = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `web-${rnd}`;
}

/** @returns {string} stable device id for this browser */
export function getDeviceId() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const id = generate();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    memoryId ??= generate();
    return memoryId;
  }
}

/**
 * C-01: a fresh key for the `Idempotency-Key` header of one payment. crypto.randomUUID needs a
 * secure context; elsewhere a v4 UUID is built from getRandomValues, and as a last resort Math.random.
 * @returns {string}
 */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
