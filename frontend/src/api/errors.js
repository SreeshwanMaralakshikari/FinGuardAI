/**
 * @file src/api/errors.js
 * @description One place that turns an axios error into a message for the UI (AUD-32).
 *   The backend sends two error shapes:
 *     { success: false, message }             — business rules, auth, 404, 500
 *     { success: false, errors: [{ msg }] }   — express-validator 422 (validate.js)
 *   Thunks used to read only `message`, so every 422 surfaced as a generic
 *   text ("Password change failed") instead of the real reason
 *   ("New password must be different from the current password").
 * @phase Phase 6 support — Phase 1–9 audit (round 2)
 */

/**
 * @param {unknown} err       error thrown by the axios instance
 * @param {string}  fallback  message when the server gave none (network error, timeout)
 * @returns {string}
 */
export function getErrorMessage(err, fallback) {
  const body = err?.response?.data;
  // FE-fix: a model-level 422 carries BOTH a generic message ('Validation failed.')
  // and the specific errors[]; show the specific one first. Validator 422s now also carry
  // `message` (= the first error's msg), so either shape resolves to the same text.
  return body?.errors?.[0]?.msg ?? body?.message ?? fallback;
}

/**
 * Message of a `rejected` thunk action: the value passed to rejectWithValue, else the thrown
 * error's message, else `fallback` (N-02: slices keep this string in `error`).
 * @param {{ payload?: unknown, error?: { message?: string } }} action
 * @param {string} fallback
 * @returns {string}
 */
export function rejectedMessage(action, fallback) {
  return (typeof action?.payload === 'string' && action.payload) || action?.error?.message || fallback;
}
