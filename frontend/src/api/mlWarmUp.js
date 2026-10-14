/**
 * @file src/api/mlWarmUp.js
 * @description D-2: ask the backend to wake the ML scoring service (POST /customer-api/ml-warm-up).
 *   The Render free ML service sleeps after 15 minutes without payments; the "Submit transaction" page calls
 *   this when it opens, so the service starts while the customer fills in the form and the payment is
 *   usually scored by the model instead of the rule-engine fallback. Fire-and-forget: it never throws,
 *   shows nothing, and the backend answers at once (it does nothing when ML is off or already awake).
 *   Kept in its own module so page tests can mock it (src/tests/setup.js) without touching api.post.
 */
import api from './axios.js';
import { API_PATHS } from '../utils/constants.js';

export function warmUpMl() {
  return api.post(API_PATHS.CUSTOMER.ML_WARM_UP).then(() => true, () => false);
}
