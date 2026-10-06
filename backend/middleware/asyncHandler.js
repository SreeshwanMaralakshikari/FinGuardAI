/**
 * asyncHandler — wraps async route handlers to forward errors to Express errorHandler.
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 * No try/catch required in any route file.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
