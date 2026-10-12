/**
 * @file src/api/socketClient.js
 * @description Shared socket.io plumbing for useNotifications / useSocket.
 *   F-04: socket.io-client is loaded with a dynamic import() the first time a signed-in layout
 *   opens a socket, so it is no longer part of the entry bundle that logged-out visitors download.
 *   F-01: an auth rejection ('UNAUTHENTICATED' from the server's handshake middleware, e.g. the
 *   JWT expired) must not retry forever — the hook disconnects and asks the normal session check
 *   to run, which sends the user to /login if the session really is over.
 */
import { SOCKET_URL } from './apiConfig.js';
import { checkAuthThunk } from '../store/slices/authSlice.js';

/** Message the server's socketAuthMiddleware uses for a missing / invalid / revoked session. */
export const SOCKET_AUTH_ERROR = 'UNAUTHENTICATED';

/** @returns {Promise<import('socket.io-client').Socket>} a connecting socket (cookie auth, websocket only) */
export async function openSocket() {
  const { io } = await import('socket.io-client');
  return io(SOCKET_URL, {
    withCredentials: true,     // send the auth cookie on the handshake
    transports: ['websocket'], // D-P6-13
  });
}

/** @param {{ message?: string }} err connect_error payload */
export const isSocketAuthError = (err) => err?.message === SOCKET_AUTH_ERROR;

// A socket that is rejected again right after a "still valid" session check must not loop.
const RECHECK_MIN_GAP_MS = 30_000;
let lastRecheckAt = 0;

/**
 * Stop the socket and re-run the session check (→ /login via ProtectedRoute when it fails).
 * @param {import('socket.io-client').Socket} socket
 * @param {Function} dispatch
 * @returns {boolean} true when a session check was started
 */
export function handleSocketAuthError(socket, dispatch) {
  socket.disconnect(); // a manual disconnect also switches the automatic reconnection off
  const now = Date.now();
  if (now - lastRecheckAt < RECHECK_MIN_GAP_MS) return false;
  lastRecheckAt = now;
  dispatch(checkAuthThunk());
  return true;
}

/** Test helper: forget the last re-check so each test starts clean. */
export function resetSocketAuthGuard() {
  lastRecheckAt = 0;
}
