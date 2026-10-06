import { body } from 'express-validator';

// AUD-24: emails are only trimmed and lower-cased — the same normalisation as
// UserModel (lowercase: true) and seed/seedAdmin.js. The previous
// .normalizeEmail() used validator.js defaults, which REMOVE dots and +tags
// from Gmail addresses (first.last@gmail.com → firstlast@gmail.com): a seeded
// admin with a dotted Gmail address could never log in, and registered users
// saw a different address from the one they typed.
//
// AUD-25: every field is required to be a string first (.isString().bail()).
// Objects/arrays used to pass notEmpty() and crash bcrypt.compare → HTTP 500.
//
// L-15: bcrypt only uses the first 72 BYTES of a password, so longer ones are
// rejected instead of being silently truncated (a 100,000-character password
// used to register and only its first 72 bytes counted). The limit is in
// bytes: non-ASCII characters take 2–4 bytes each.

const MAX_PASSWORD_BYTES = 72;
const withinBcryptLimit = (value) => Buffer.byteLength(String(value), 'utf8') <= MAX_PASSWORD_BYTES;
const PASSWORD_TOO_LONG = `Password must be at most ${MAX_PASSWORD_BYTES} characters (${MAX_PASSWORD_BYTES} bytes — non-English characters count as more than one)`;

export const registerRules = [
  body('name')
    .isString().withMessage('Name must be a string').bail()
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

  body('email')
    .isString().withMessage('A valid email address is required').bail()
    .trim()
    .isEmail().withMessage('A valid email address is required')
    .toLowerCase(),

  body('password')
    .isString().withMessage('Password must be a string').bail()
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters').bail()
    .custom(withinBcryptLimit).withMessage(PASSWORD_TOO_LONG),

  body('role')
    .isString().withMessage('Role must be CUSTOMER or ANALYST — ADMIN is seeded only').bail() // N-26: arrays passed isIn and failed in Mongoose
    .isIn(['CUSTOMER', 'ANALYST']).withMessage('Role must be CUSTOMER or ANALYST — ADMIN is seeded only'),

  // L-11: required (and checked in the route) only for role ANALYST; ignored for CUSTOMER.
  body('inviteCode')
    .optional({ values: 'null' })
    .isString().withMessage('Invite code must be a string').bail()
    .isLength({ max: 200 }).withMessage('Invite code is too long'),
];

export const loginRules = [
  body('email')
    .isString().withMessage('A valid email address is required').bail()
    .trim()
    .isEmail().withMessage('A valid email address is required')
    .toLowerCase(),

  body('password')
    .isString().withMessage('Password is required').bail()
    .notEmpty().withMessage('Password is required'),
];

export const changePasswordRules = [
  body('currentPassword')
    .isString().withMessage('Current password is required').bail()
    .notEmpty().withMessage('Current password is required'),

  body('newPassword')
    .isString().withMessage('New password must be a string').bail()
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters').bail()
    .custom(withinBcryptLimit).withMessage(PASSWORD_TOO_LONG).bail()
    .custom((value, { req }) => {
      if (value === req.body.currentPassword) {
        throw new Error('New password must be different from the current password');
      }
      return true;
    }),
];
