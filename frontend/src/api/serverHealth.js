/**
 * @file src/api/serverHealth.js
 * @description Cold-start handling for the Render free tier.
 *   A free Render service spins down after 15 minutes without inbound
 *   traffic; the next request wakes it, which takes about a minute. These
 *   helpers poll GET /health until the API (and its MongoDB connection) is
 *   ready, and remember when the server last answered so callers can tell
 *   whether it may have fallen asleep.
 *
 *   Uses fetch() rather than the axios instance on purpose:
 *     - no dependency cycle with api/axios.js (which imports this file)
 *     - no 401 interceptor / cookies involved (health is public)
 * @phase Phase 9 — Deployment
 */
import { HEALTH_URL } from './apiConfig.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastServerContactAt = 0;

/** Record that the API just answered (any HTTP status proves it is awake). */
export function markServerContact() {
  lastServerContactAt = Date.now();
}

/** @returns {number} ms since the API last answered (Infinity if never) */
export function msSinceServerContact() {
  return lastServerContactAt ? Date.now() - lastServerContactAt : Number.POSITIVE_INFINITY;
}

/**
 * Single health probe.
 * Requires a JSON body with status "ok" — not just a 2xx — so an HTML
 * placeholder page served by a proxy while the service boots can never be
 * mistaken for a ready API.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function pingServer(timeoutMs = 8_000) {
  try {
    const response = await fetch(HEALTH_URL, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    const ready = body?.status === 'ok';
    if (ready) markServerContact();
    return ready;
  } catch {
    return false; // network error, timeout, CORS failure, non-JSON body
  }
}

let inFlightWake = null;

/**
 * Poll /health until it succeeds or maxWaitMs elapses.
 * Concurrent callers share one polling loop (e.g. the wake gate plus several
 * axios requests) so the server is never flooded with health checks.
 *
 * @param {{ maxWaitMs?: number, attemptTimeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<boolean>} true when the server is ready
 */
export function waitForServer({
  maxWaitMs = 90_000,
  attemptTimeoutMs = 10_000,
  intervalMs = 3_000,
} = {}) {
  if (inFlightWake) return inFlightWake;

  inFlightWake = (async () => {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (await pingServer(Math.min(attemptTimeoutMs, remaining))) return true;
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    return false;
  })().finally(() => {
    inFlightWake = null;
  });

  return inFlightWake;
}
