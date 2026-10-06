/**
 * @file utils/socketAuth.js
 * @description Socket.io handshake authentication using the same HTTP-only
 *   JWT cookie as the REST API.
 *
 *   Why: before Phase 9 a client joined a notification room by emitting
 *   'join' with any user ID — on a public URL anyone could subscribe to
 *   another user's notifications. Now the server reads the `token` cookie
 *   from the WebSocket handshake, verifies it, and joins the socket to the
 *   authenticated user's own room. The client's 'join' emit is kept for
 *   compatibility but can no longer join someone else's room.
 *
 *   The browser sends the cookie on the handshake because the frontend
 *   connects with `withCredentials: true` and the cookie is SameSite=None
 *   (or first-party SameSite=Lax with COOKIE_MODE=same-site).
 *
 *   L-06: the handshake also rejects deactivated users and tokens issued at or
 *   before the last password change; sessions that end LATER are closed by
 *   utils/socketManager.js disconnectUser().
 * @phase Phase 9 — Deployment
 */
import jwt from 'jsonwebtoken';
import UserModel from '../models/UserModel.js';
import { isTokenRevoked } from '../middleware/verifyToken.js';
import { hashToken } from './socketManager.js';

/**
 * Minimal Cookie header parser (avoids depending on a transitive package).
 * @param {string} header — raw Cookie header, e.g. "a=1; token=eyJ..."
 * @returns {Record<string, string>}
 */
export const parseCookies = (header = '') =>
  header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key && !Object.hasOwn(acc, key)) { // first occurrence wins, like cookie-parser
      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        acc[key] = value;
      }
    }
    return acc;
  }, {});

/**
 * io.use() middleware — attaches socket.data.user or rejects the connection.
 * Rejection reaches the client as a 'connect_error' event with err.message.
 */
export const socketAuthMiddleware = async (socket, next) => {
  try {
    const { token } = parseCookies(socket.handshake.headers.cookie);
    if (!token) return next(new Error('UNAUTHENTICATED'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await UserModel.findById(decoded.id).select('_id role isActive +passwordChangedAt').lean();

    if (!user || !user.isActive || isTokenRevoked(user, decoded)) return next(new Error('UNAUTHENTICATED')); // AUD-23

    socket.data.user = { id: user._id.toString(), role: user.role };
    socket.data.tokenHash = hashToken(token); // L-06: lets logout close only THIS session's sockets
    // [P9] The JWT is only checked at handshake. Remember when it expires so
    // server.js can drop the socket at that moment (REST calls would 401).
    socket.data.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
    return next();
  } catch {
    return next(new Error('UNAUTHENTICATED'));
  }
};
