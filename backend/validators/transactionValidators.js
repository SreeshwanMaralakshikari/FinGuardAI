import { body } from 'express-validator';

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
    .isFloat({ gt: 0, max: 1_000_000_000 }).withMessage('Amount must be greater than 0 and at most ₹1,00,00,00,000')
    .toFloat(), // AUD-10: form inputs arrive as strings — store and score a real Number

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
    .isIn(['UPI', 'CARD', 'NET_BANKING', 'WALLET']).withMessage('Payment method must be UPI, CARD, NET_BANKING, or WALLET'),

  body('location')
    .optional()
    .isObject().withMessage('Location must be an object with city and country fields'),

  body('location.city')
    .optional()
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
];
