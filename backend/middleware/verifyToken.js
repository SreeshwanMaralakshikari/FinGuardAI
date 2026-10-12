import jwt from 'jsonwebtoken';
import UserModel from '../models/UserModel.js';
import asyncHandler from './asyncHandler.js';
import { getClearAuthCookieOptions } from '../config/cookieOptions.js';

/**
 * AUD-23 / L-15: true when the token was issued at or before the user's last
 * password change. Shared with utils/socketAuth.js so REST and WebSocket
 * sessions end together.
 *
 * `passwordChangedAt` is the exact instant of the change (no back-dating).
 * A JWT's own `iat` only has 1-second resolution, so tokens carry an extra
 * `iatMs` claim (CommonAPI.issueTokenCookie) and the comparison is exact:
 *   • with iatMs:    revoked  ⇔ iatMs ≤ changedAt            (ms precision)
 *   • without iatMs: revoked  ⇔ iat·1000 ≤ changedAt          (older tokens; a token
 *     minted in the same second as the change is treated as "before" — safe side)
 *
 * C-09: `sessionsRevokedAt` (set when an admin deactivates the account) works the
 * same way, so a cookie stolen before a deactivation does not come back to life
 * when the account is re-activated. The later of the two instants applies.
 * @param {{ passwordChangedAt?: Date|null, sessionsRevokedAt?: Date|null }} user
 * @param {{ iat?: number, iatMs?: number }} decoded  verified JWT payload
 */
export const isTokenRevoked = (user, decoded) => {
  const cutoffs = [user?.passwordChangedAt, user?.sessionsRevokedAt]
    .filter(Boolean)
    .map((date) => new Date(date).getTime());
  if (cutoffs.length === 0) return false;
  const issuedAt = Number.isFinite(decoded?.iatMs) ? decoded.iatMs : (decoded?.iat ?? 0) * 1000;
  return issuedAt <= Math.max(...cutoffs);
};

/**
 * Factory for the authentication middleware.
 * @param {{ clearCookieOnFailure?: boolean }} [options]
 *   clearCookieOnFailure — also send a Set-Cookie that removes the `token`
 *   cookie when it is invalid, expired, revoked or belongs to a deactivated
 *   account (L-15). Used only by /auth/logout and /auth/check-auth: clearing it
 *   on every route could delete a NEW cookie that a parallel login just set.
 */
const createVerifyToken = ({ clearCookieOnFailure = false } = {}) =>
  asyncHandler(async (req, res, next) => {
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }

    const reject = (status, message, code) => {
      if (clearCookieOnFailure) res.clearCookie('token', getClearAuthCookieOptions());
      return res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
    };

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return reject(401, 'Session expired. Please log in again.');
    }

    const user = await UserModel.findById(decoded.id).select('-password +passwordChangedAt +sessionsRevokedAt');
    if (!user) {
      return reject(401, 'User account not found.');
    }
    // E-01: a deactivated account's live session is a 401 (the session is over), not a 403, so the
    // frontend's existing "session ended → sign in" handling applies. `code` lets clients tell it
    // apart from an expired session. Checked BEFORE the revocation test so the reason is accurate.
    // (POST /auth/login for a deactivated user stays 403 — that is a refused login, not a dead session.)
    if (!user.isActive) {
      return reject(401, 'Account has been deactivated. Contact support.', 'ACCOUNT_DEACTIVATED');
    }
    if (isTokenRevoked(user, decoded)) { // AUD-23 / C-09: password changed / sessions revoked after this token was issued
      return reject(401, 'Session expired. Please log in again.');
    }

    req.user = user;
    next();
  });

/**
 * verifyToken — reads JWT from HTTP-only cookie, verifies signature,
 * loads the user from DB, blocks deactivated accounts, attaches req.user.
 */
export const verifyToken = createVerifyToken();

/** Same as verifyToken, but clears the cookie when authentication fails (logout, check-auth). */
export const verifyTokenClearingCookie = createVerifyToken({ clearCookieOnFailure: true });

/**
 * authorizeRoles — RBAC factory. Pass one or more role strings.
 * Usage: authorizeRoles('ANALYST', 'ADMIN')
 * Must be used AFTER verifyToken (req.user must be set).
 */
export const authorizeRoles = (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
