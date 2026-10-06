import rateLimit from 'express-rate-limit';

/**
 * authLimiter — applied to POST /auth/login.
 * 10 FAILED attempts per 15-minute window per IP (AUD-28).
 * skipSuccessfulRequests: a whole class on one college Wi-Fi shares one public
 * IP; counting successful logins would lock everyone out after 10 sign-ins.
 * Brute-force protection is unchanged: wrong passwords (401) still count.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again in 15 minutes.' },
});

/**
 * registerLimiter — applied to POST /auth/register (L-12).
 * Counts EVERY request (successful ones too): registration creates data and
 * burns a bcrypt hash, so unlimited successful sign-ups from one IP are an
 * abuse vector that authLimiter (failures only) never covered. Own store, so
 * failed logins no longer block registration from the same IP and vice versa.
 * 20 per hour per IP leaves room for a classroom behind one public IP.
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts. Please try again in 1 hour.' },
});

/**
 * changePasswordLimiter — applied to PATCH /auth/change-password AFTER
 * verifyToken and the validators (L-12). Keyed by user id (falls back to IP):
 * 5 FAILED attempts (wrong current password → 400) per 15 minutes. A stolen
 * session could otherwise guess the current password without limit.
 */
export const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `user:${req.user._id}` : req.ip),
  message: { success: false, message: 'Too many failed attempts. Please try again in 15 minutes.' },
});

/**
 * profileUpdateLimiter — applied to PATCH /customer-api/profile. Every call may
 * upload an image to Cloudinary (quota, bandwidth), so a signed-in user gets
 * 20 updates per hour (keyed by user id, falls back to IP).
 */
export const profileUpdateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `user:${req.user._id}` : req.ip),
  message: { success: false, message: 'Too many profile updates. Please try again later.' },
});

/**
 * transactionLimiter — applied to POST /customer-api/transactions.
 * 30 requests per 1-minute window, keyed by the authenticated user id (falls
 * back to IP). Per-IP keys made a classroom demoing behind one public IP share
 * a single bucket (L-12).
 */
export const transactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `user:${req.user._id}` : req.ip),
  message: { success: false, message: 'Transaction rate limit exceeded. Please slow down.' },
});
