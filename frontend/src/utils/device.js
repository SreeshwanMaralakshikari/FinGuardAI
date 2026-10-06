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
