/**
 * @file validators/payeeValidators.js
 * @description TEJAS D1: the analyst payee routes (watchlist and payee profile).
 *   Every value must be a string first (?key[$ne]= arrives as an object), then is checked against the exact
 *   payee-key / UPI-ID shapes of utils/payee.js, so nothing unexpected can reach a database filter.
 */
import { body, param, query } from 'express-validator';
import { VPA_PATTERN, VPA_MAX_LENGTH, normalizeVpa, normalizeMerchantName, isPayeeKey } from '../utils/payee.js';
import { VPA_MESSAGE } from './transactionValidators.js';

const NOTE_MAX = 300;
const MERCHANT_MAX = 200;

const note = (location) => location('note')
  .optional({ values: 'null' })
  .isString().withMessage('Note must be text').bail()
  .trim()
  .isLength({ max: NOTE_MAX }).withMessage(`Note cannot exceed ${NOTE_MAX} characters`);

/** POST /analyst-api/payees/watchlist — exactly one of { vpa, merchantName }, plus an optional note. */
export const addWatchlistRules = [
  body().custom((value) => {
    // Blank text counts as "not given" (express-validator's optional() also skips a value that trims to '').
    const given = (v) => (typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null);
    const hasVpa = given(value?.vpa);
    const hasMerchant = given(value?.merchantName);
    if (hasVpa === hasMerchant) throw new Error('Give either a payee UPI ID (vpa) or a merchant name, not both');
    return true;
  }),
  body('vpa')
    .optional({ values: 'falsy' })
    .isString().withMessage(VPA_MESSAGE).bail()
    .isLength({ max: VPA_MAX_LENGTH }).withMessage(VPA_MESSAGE).bail()
    .customSanitizer(normalizeVpa)
    .matches(VPA_PATTERN).withMessage(VPA_MESSAGE),
  body('merchantName')
    .optional({ values: 'falsy' })
    .isString().withMessage('Merchant name must be text').bail()
    .trim()
    .notEmpty().withMessage('Merchant name cannot be empty').bail()
    .isLength({ max: MERCHANT_MAX }).withMessage(`Merchant name cannot exceed ${MERCHANT_MAX} characters`).bail()
    .custom((value) => normalizeMerchantName(value).length > 0).withMessage('Merchant name cannot be empty'),
  note(body),
];

/** DELETE /analyst-api/payees/watchlist/:id — soft removal with an optional note. */
export const removeWatchlistRules = [
  param('id').isMongoId().withMessage('A valid watchlist entry id is required'),
  note(body),
];

/** GET /analyst-api/payees/watchlist?status=active|removed|all (default active). */
export const listWatchlistRules = [
  query('status')
    .optional({ values: 'falsy' })
    .isString().withMessage('status must be one of: active, removed, all').bail()
    .isIn(['active', 'removed', 'all']).withMessage('status must be one of: active, removed, all'),
];

/** GET /analyst-api/payees/profile?key=vpa:ravi@okaxis */
export const payeeProfileRules = [
  query('key')
    .exists({ values: 'falsy' }).withMessage('A payee key is required').bail()
    .isString().withMessage('Payee key must be text').bail()
    .custom(isPayeeKey).withMessage('Payee key must be "vpa:<UPI ID>" or "merchant:<merchant name>"'),
];
