/**
 * @file src/api/session.js
 * @description Cancels every in-flight API request when the session changes (AUD-40).
 *   Each request carries the current session's AbortSignal (added by the
 *   request interceptor in api/axios.js). Logout, login and a completed password
 *   change call endSessionRequests(): requests started by the previous session
 *   are aborted, so a slow response for user A can no longer land in the store
 *   after it was reset for user B (their thunks end as `rejected`, which only
 *   clears loading flags).
 *   Kept in its own module (not axios.js) so slice tests that mock axios.js
 *   still get the real implementation.
 * @phase Phase 6 support — Phase 1–9 audit (round 3)
 */
let controller = new AbortController();

/** @returns {AbortSignal} signal of the current session */
export const getSessionSignal = () => controller.signal;

/** Abort all requests of the current session and start a new one. */
export function endSessionRequests() {
  controller.abort();
  controller = new AbortController();
}
