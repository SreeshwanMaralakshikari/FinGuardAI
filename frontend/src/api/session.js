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

// ─── "Why was I signed out?" notice (E-01) ───────────────────────────────────
// The axios interceptor forces a hard redirect to /login when the server ends a session. React
// state does not survive that, so the reason travels in sessionStorage (tab-scoped, cleared when
// the tab closes) and the login page shows it once. Every access is guarded: storage can throw
// (private mode, blocked site data) and the app must work without it.
const NOTICE_KEY = 'finguard:session-notice';

/** Shown on /login after the server ended the session because the account was deactivated. */
export const DEACTIVATED_NOTICE = 'Account has been deactivated. Contact support.';

/** @param {string} message text to show on the login page */
export function rememberSessionNotice(message) {
  try { sessionStorage.setItem(NOTICE_KEY, message); } catch { /* storage unavailable: no notice */ }
}

/** @returns {string} the pending notice ('' when none) — does not clear it */
export function peekSessionNotice() {
  try { return sessionStorage.getItem(NOTICE_KEY) ?? ''; } catch { return ''; }
}

export function clearSessionNotice() {
  try { sessionStorage.removeItem(NOTICE_KEY); } catch { /* ignore */ }
}
