import { validationResult } from 'express-validator';

/**
 * validate — bridge between express-validator rule chains and route handlers.
 * Place after validator rule arrays in the middleware chain: [...rules, validate, handler].
 * Returns HTTP 422 with { success: false, message, errors: [...] } on validation failure.
 * `message` is the first error's message, so clients that only show `message`
 * (the frontend's generic handler) display something useful (N-26); `errors`
 * keeps the full express-validator list.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    return res.status(422).json({
      success: false,
      message: list[0]?.msg ?? 'Validation failed.',
      // `value` is dropped on purpose: it would echo passwords back to the client.
      errors: list.map((e) => ({ type: e.type, path: e.path, location: e.location, msg: e.msg })),
    });
  }
  next();
};

export default validate;
