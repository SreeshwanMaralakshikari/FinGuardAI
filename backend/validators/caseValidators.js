import { body } from 'express-validator';

export const createCaseRules = [
  body('fraudAlertId')
    .isMongoId().withMessage('A valid fraud alert ID is required'),

  body('initialNote')
    .optional()
    .isString().withMessage('Initial note must be a string').bail() // AUD-25: arrays crashed .trim() in the route (500)
    .trim()
    .notEmpty().withMessage('Initial note cannot be an empty string')
    .isLength({ max: 2000 }).withMessage('Initial note cannot exceed 2000 characters'),
];

const CLOSING_STATUSES = ['RESOLVED', 'DISMISSED'];

export const updateStatusRules = [
  body('status')
    .isString().withMessage('Status must be one of: OPEN, ASSIGNED, UNDER_REVIEW, RESOLVED, DISMISSED').bail()
    .isIn(['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'])
    .withMessage('Status must be one of: OPEN, ASSIGNED, UNDER_REVIEW, RESOLVED, DISMISSED'),

  // Required (non-empty string) when closing the case.
  body('resolutionSummary')
    .if(body('status').isIn(CLOSING_STATUSES))
    .isString().withMessage('Resolution summary is required when resolving or dismissing a case').bail()
    .trim() // AUD-25: "   " passed notEmpty() and was stored as "" after the model's trim
    .notEmpty().withMessage('Resolution summary is required when resolving or dismissing a case')
    .isLength({ max: 5000 }).withMessage('Resolution summary cannot exceed 5000 characters'),

  // N-25: for every other status it is optional, but whenever present it must
  // still be a string (an object used to reach Mongoose → raw "Cast to string failed").
  body('resolutionSummary')
    .if(body('status').not().isIn(CLOSING_STATUSES))
    .optional({ values: 'null' })
    .isString().withMessage('Resolution summary must be a string').bail()
    .trim()
    .isLength({ max: 5000 }).withMessage('Resolution summary cannot exceed 5000 characters'),
];

export const addNoteRules = [
  body('text')
    .isString().withMessage('Note text is required').bail() // AUD-25
    .trim()
    .notEmpty().withMessage('Note text is required')
    .isLength({ max: 2000 }).withMessage('Note text cannot exceed 2000 characters'),
];
