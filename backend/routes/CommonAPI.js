import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authLimiter, registerLimiter, changePasswordLimiter } from '../middleware/rateLimiter.js';
import { verifyToken, verifyTokenClearingCookie } from '../middleware/verifyToken.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { registerRules, loginRules, changePasswordRules } from '../validators/authValidators.js';
import UserModel from '../models/UserModel.js';
import createAuditLog from '../utils/createAuditLog.js';
import { disconnectUser } from '../utils/socketManager.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../config/cookieOptions.js'; // [P9]

const router = express.Router();

// L-09: bcrypt hash (cost 12, same as UserModel) of a random string nobody knows.
// Compared against when the e-mail is unknown, so "no such user" costs the same
// ~250 ms as "wrong password" and response time does not reveal which e-mails exist.
const DUMMY_PASSWORD_HASH = '$2b$12$ElQR88WEyW.Puzwis0HBQu2sbmA5/1LFCkWn5G5xw.vXct3BTIJ5S';

/** Constant-time string comparison (hashes first so the lengths always match). */
const safeEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// ── Cookie config ─────────────────────────────────────────────────────────────
// [P9] The hardcoded sameSite:'strict' COOKIE_OPTIONS / CLEAR_COOKIE_OPTIONS
// objects were replaced by environment-aware options (config/cookieOptions.js):
//   production, COOKIE_MODE=cross-site (default) → { httpOnly, secure: true, sameSite: 'none', partitioned: true, path: '/' }
//   production, COOKIE_MODE=same-site            → { httpOnly, secure: true, sameSite: 'lax', path: '/', domain? }
//   development / test                           → { httpOnly, secure: false, sameSite: 'lax', path: '/' }
// With sameSite:'strict' the browser would NEVER attach the cookie to requests
// from the Vercel site to the Render API, so every call after login would 401.

// ── Helper: sign JWT and attach cookie ────────────────────────────────────────
// `iatMs` is the issue time in milliseconds: the standard `iat` claim only has
// 1-second resolution, which is too coarse to tell a token issued just before a
// password change from one issued just after it (see isTokenRevoked, L-15).
const issueTokenCookie = (res, userId) => {
  const token = jwt.sign({ id: userId, iatMs: Date.now() }, process.env.JWT_SECRET, { expiresIn: '6h' });
  res.cookie('token', token, getAuthCookieOptions()); // [P9]
};

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post(
  '/register',
  registerLimiter, // L-12: counts every request, not only failures
  registerRules,
  validate,
  asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;

    // L-11: ANALYST accounts can read every customer's flagged transactions, so
    // they cannot be self-created by anyone who finds the URL. Checked BEFORE the
    // duplicate-email lookup so a wrong code reveals nothing about existing accounts.
    // CUSTOMER registration ignores inviteCode.
    if (role === 'ANALYST') {
      const configuredCode = (process.env.ANALYST_INVITE_CODE ?? '').trim();
      if (!configuredCode) {
        return res.status(403).json({ success: false, message: 'Analyst registration is disabled.' });
      }
      if (!safeEqual(String(req.body.inviteCode ?? '').trim(), configuredCode)) {
        return res.status(403).json({ success: false, message: 'Invalid invite code.' });
      }
    }

    const existing = await UserModel.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    // UserModel pre-save hook hashes the password (bcrypt cost 12)
    const user = await UserModel.create({ name, email, password, role });

    await createAuditLog(
      user._id,
      user.role,
      'USER_REGISTERED',
      'User',
      user._id.toString(),
      { email: user.email, role: user.role },
      req.ip
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful. You may now log in.',
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  })
);

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post(
  '/login',
  authLimiter,
  loginRules,
  validate,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // .select('+password') overrides the schema's select:false on the password field
    const user = await UserModel.findOne({ email }).select('+password');

    // Generic message prevents user enumeration. L-09: an unknown e-mail still
    // pays for one bcrypt comparison, so both outcomes take the same time.
    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // BS-19: failed logins for a real account are audited (no password is stored).
      // An unknown e-mail has no actor to attribute the entry to, so it is not logged.
      await createAuditLog(user._id, user.role, 'LOGIN_FAILED', 'User', user._id.toString(),
        { email: user.email, reason: 'WRONG_PASSWORD' }, req.ip);
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // AUD-28: checked AFTER the password, so the 403 cannot be used to discover
    // which accounts exist and are deactivated without knowing their password.
    if (!user.isActive) {
      await createAuditLog(user._id, user.role, 'LOGIN_FAILED', 'User', user._id.toString(),
        { email: user.email, reason: 'ACCOUNT_DEACTIVATED' }, req.ip);
      return res.status(403).json({ success: false, message: 'Account has been deactivated. Please contact support.' });
    }

    // Update lastLogin (direct set avoids triggering the password pre-save hook)
    await UserModel.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    issueTokenCookie(res, user._id);

    await createAuditLog(
      user._id,
      user.role,
      'USER_LOGIN',
      'User',
      user._id.toString(),
      { email: user.email },
      req.ip
    );

    res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage,
        trustScore: user.trustScore,
      },
    });
  })
);

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post(
  '/logout',
  verifyTokenClearingCookie, // L-15: an invalid/expired/deactivated session still gets its cookie removed
  asyncHandler(async (req, res) => {
    await createAuditLog(
      req.user._id,
      req.user.role,
      'USER_LOGOUT',
      'User',
      req.user._id.toString(),
      {},
      req.ip
    );

    res.clearCookie('token', getClearAuthCookieOptions()); // [P9]
    // L-06: close the live socket(s) of THIS session (other devices keep theirs).
    await disconnectUser(req.user._id, { token: req.cookies.token });
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  })
);

// ── GET /auth/check-auth ──────────────────────────────────────────────────────
// Called by Redux checkAuthThunk on every app mount / page refresh.
// No audit log — read-only identity check, not a sensitive action.
router.get(
  '/check-auth',
  verifyTokenClearingCookie, // L-15: clears a dead cookie so the browser stops sending it
  asyncHandler(async (req, res) => {
    res.status(200).json({
      success: true,
      data: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        profileImage: req.user.profileImage,
        trustScore: req.user.trustScore,
        isActive: req.user.isActive,
      },
    });
  })
);

// ── PATCH /auth/change-password ───────────────────────────────────────────────
router.patch(
  '/change-password',
  verifyToken,
  changePasswordRules,
  validate,
  changePasswordLimiter, // L-12: 5 failed attempts / 15 min per user (after validation: only real password guesses count)
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    // Re-fetch with password field for bcrypt comparison
    const user = await UserModel.findById(req.user._id).select('+password');

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    // Assign plain-text; UserModel pre-save hook hashes it
    user.password = newPassword;
    await user.save();

    await createAuditLog(
      req.user._id,
      req.user.role,
      'PASSWORD_CHANGED',
      'User',
      req.user._id.toString(),
      {},
      req.ip
    );

    // Invalidate session — force re-login with new credentials
    res.clearCookie('token', getClearAuthCookieOptions()); // [P9]
    // L-06: every existing token is now revoked, so close ALL of this user's live sockets.
    await disconnectUser(req.user._id);
    res.status(200).json({ success: true, message: 'Password updated. Please log in again.' });
  })
);

export default router;
