/**
 * @file utils/socketManager.js
 * @description Module-level Socket.io singleton and the single emit gateway.
 *   setIO(io) is called once in server.js; getIO() is used by routes and
 *   utils (createNotification, CustomerAPI, AdminAPI) to emit events without
 *   importing server.js (which would create a circular dependency).
 *   getIO() throws if called before setIO() — every call site already wraps
 *   the emit in try/catch (N-P4-04), so the throw is non-fatal by design.
 *
 *   [P9] Event scoping policy — because every emit goes through getIO(), the
 *   audience rule lives here in one place:
 *     • ADMIN_ONLY_EVENTS ('fraud_alert', 'simulation_start', 'simulation_stop')
 *       are delivered only to the `role:ADMIN` room, even when a caller uses
 *       the broadcast form getIO().emit(...). These payloads contain other
 *       users' transaction data and must never reach customer/analyst sockets.
 *     • Every other broadcast, and every targeted getIO().to(room).emit(...)
 *       (e.g. 'new-notification' to a user's own room), is unchanged.
 *
 *   [L-06] disconnectUser(userId) force-closes a user's live sockets when their
 *   REST session ends (logout, deactivation, password change). The socket
 *   handshake is the only place a JWT is checked, so without this a revoked
 *   session kept receiving notifications until the token expired (6 h).
 * @phase Phase 2 spec → Phase 9 (implementation + scoping policy)
 */

import { createHash } from 'node:crypto';

/** Room names — shared with server.js so join and emit can never disagree. */
export const userRoom = (userId) => String(userId);
export const roleRoom = (role) => `role:${role}`;

export const ADMIN_ONLY_EVENTS = Object.freeze(
  new Set(['fraud_alert', 'simulation_start', 'simulation_stop'])
);

let ioInstance = null;
let scopedIO = null;

/**
 * Wraps the real Server so that only `emit` is intercepted. All other
 * properties and methods (to, in, sockets, close, …) are forwarded to the
 * real instance with `this` bound correctly.
 * @param {import('socket.io').Server} io
 */
const createScopedIO = (io) =>
  new Proxy(io, {
    get(target, prop) {
      if (prop === 'emit') {
        return (event, ...args) =>
          ADMIN_ONLY_EVENTS.has(event)
            ? target.to(roleRoom('ADMIN')).emit(event, ...args)
            : target.emit(event, ...args);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/** @param {import('socket.io').Server} io */
export const setIO = (io) => {
  ioInstance = io;
  scopedIO = createScopedIO(io);
};

/** @returns {import('socket.io').Server} the scoped emit gateway */
export const getIO = () => {
  if (!ioInstance) {
    throw new Error('Socket.io has not been initialised — call setIO() in server.js first.');
  }
  return scopedIO;
};

/** Stable fingerprint of a JWT (stored on the socket instead of the token itself). */
export const hashToken = (token) =>
  createHash('sha256').update(String(token ?? '')).digest('hex');

/**
 * Force-disconnect the live sockets of one user (L-06). Safe to call when
 * Socket.io is not initialised (tests, scripts) — it then does nothing.
 *
 * @param {string|{ toString(): string }} userId
 * @param {{ token?: string }} [options]
 *   token — only close sockets that authenticated with THIS JWT (logout ends
 *   one session, the same user's other devices stay connected). Omit to close
 *   every socket of the user (deactivation, password change: all tokens are dead).
 * @returns {Promise<number>} how many sockets were disconnected
 */
export const disconnectUser = async (userId, { token } = {}) => {
  if (!ioInstance) return 0;
  try {
    const sockets = await ioInstance.in(userRoom(userId)).fetchSockets();
    const wanted = token ? hashToken(token) : null;
    let closed = 0;
    for (const socket of sockets) {
      if (wanted && socket.data?.tokenHash !== wanted) continue;
      socket.disconnect(true);
      closed += 1;
    }
    return closed;
  } catch (err) {
    console.error('[socketManager] disconnectUser failed:', err.message);
    return 0;
  }
};
