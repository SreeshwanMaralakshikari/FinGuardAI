/**
 * @file middleware/errorHandler.js
 * @description Global Express error handler (4-arg). Registered last in app.js.
 *   Every error thrown in an asyncHandler-wrapped route ends up here (D-P4-04).
 *   Maps known error types to HTTP codes and always responds with the
 *   standard envelope: { success: false, message, errors? }.
 *
 *   | Source                                   | HTTP |
 *   |------------------------------------------|------|
 *   | Mongoose ValidationError                 | 422  | (message = first error message, errors[] = all)
 *   | Mongoose CastError (bad ObjectId, etc.)  | 400  |
 *   | MongoDB duplicate key (code 11000)       | 409  |
 *   | Multer errors (file too large, etc.)     | 400  |
 *   | Invalid upload type (err.status = 400)   | 400  |
 *   | Malformed JSON body (express.json)       | 400  |
 *   | Anything else                            | 500  |
 *
 *   500 responses never leak internal messages or stacks in production.
 * @phase Phase 2 spec → implementation recorded in the Phase 1–9 audit
 */
import mongoose from 'mongoose';
import multer from 'multer';

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args)
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Mongoose schema validation → 422 with per-field messages
  if (err instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(err.errors).map((e) => ({ path: e.path, msg: e.message }));
    // message = first field error (same contract as middleware/validate.js, N-26)
    return res.status(422).json({ success: false, message: errors[0]?.msg ?? 'Validation failed.', errors });
  }

  // Invalid ObjectId / type cast in a query → 400
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ success: false, message: `Invalid value for ${err.path}.` });
  }

  // Unique index violation → 409
  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue ?? err.keyPattern ?? {})[0] ?? 'field';
    return res.status(409).json({ success: false, message: `Duplicate value for ${field}.` });
  }

  // Multer upload errors (e.g. LIMIT_FILE_SIZE) → 400
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB).' : err.message;
    return res.status(400).json({ success: false, message });
  }

  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON in request body.' });
  }

  // Errors that carry an explicit 4xx status (e.g. uploadMiddleware file filter)
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ success: false, message: err.message });
  }

  console.error('[errorHandler]', err);
  const isProduction = process.env.NODE_ENV === 'production';
  return res.status(500).json({
    success: false,
    message: isProduction ? 'Internal server error.' : (err?.message ?? 'Internal server error.'),
  });
};

export default errorHandler;
