import { body, header } from 'express-validator';
import { PAYMENT_METHODS } from '../utils/enums.js';

/** C-01: format of the optional Idempotency-Key request header. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 1_000_000_000;
/** E-07: money has 2 decimals — round half up, with a tiny epsilon against 1.005 → 1.00 float noise. */
const roundToPaise = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// L-10: every free-text field is required to be a STRING first (.isString().bail()),
// then trimmed and length-capped. Before, `merchantCategory: ["CASINO"]` crashed the
// fraud service (HTTP 500), objects were stored as "[object Object]", and
// `deviceId: {"$gt": ""}` created a shared junk reputation row.

export const submitTransactionRules = [
  body('amount')
    // L-10: only a number or a numeric string (arrays/objects/booleans are rejected up front)
    .custom((value) => typeof value === 'number' || typeof value === 'string')
    .withMessage('Amount must be a number').bail()
    // AUD-27: upper bound — "1e400" passed isFloat and became Infinity (NaN loss / 500)
    // E-07: the same minimum as the model (0.01), so 0.005 gets an accurate message instead of a Mongoose error.
    .isFloat({ min: MIN_AMOUNT, max: MAX_AMOUNT }).withMessage('Amount must be at least ₹0.01 and at most ₹1,00,00,00,000')
    .toFloat() // AUD-10: form inputs arrive as strings — store and score a real Number
    .customSanitizer(roundToPaise), // E-07: at most 2 decimals (100.123456789 → 100.12)

  body('merchantName')
    .isString().withMessage('Merchant name must be a string').bail()
    .trim()
    .notEmpty().withMessage('Merchant name is required')
    .isLength({ max: 200 }).withMessage('Merchant name cannot exceed 200 characters'),

  body('merchantCategory')
    .optional()
    .isString().withMessage('Merchant category must be a string').bail()
    .trim()
    .notEmpty().withMessage('Merchant category cannot be an empty string')
    .isLength({ max: 50 }).withMessage('Merchant category cannot exceed 50 characters'),

  body('paymentMethod')
    .isString().withMessage('Payment method must be UPI, CARD, NET_BANKING, or WALLET').bail()
    .isIn(PAYMENT_METHODS).withMessage('Payment method must be UPI, CARD, NET_BANKING, or WALLET'),

  // E-06: location.city is REQUIRED. Leaving it out used to disable the location rule
  // (the model defaulted the city to "Unknown", which the rule skips). The country stays optional (default IN).
  body('location')
    .isObject().withMessage('Location must be an object with a city (required) and an optional country'),

  body('location.city')
    .exists({ values: 'null' }).withMessage('Location city is required').bail()
    .isString().withMessage('Location city must be a string').bail()
    .trim()
    .notEmpty().withMessage('Location city cannot be an empty string')
    .isLength({ max: 100 }).withMessage('Location city cannot exceed 100 characters'),

  body('location.country')
    .optional()
    .isString().withMessage('Location country must be a string').bail()
    .trim()
    .notEmpty().withMessage('Location country cannot be an empty string')
    .isLength({ max: 100 }).withMessage('Location country cannot exceed 100 characters'),

  body('deviceId')
    .isString().withMessage('Device ID must be a string').bail()
    .trim()
    .notEmpty().withMessage('Device ID is required')
    .isLength({ max: 128 }).withMessage('Device ID cannot exceed 128 characters'),

  // C-01: optional; when present it must be 8–100 of A-Z a-z 0-9 _ - (an empty or repeated header fails too).
  header('Idempotency-Key')
    .optional()
    .matches(IDEMPOTENCY_KEY_PATTERN)
    .withMessage('Idempotency-Key must be 8 to 100 characters: letters, digits, "_" or "-"'),
];
