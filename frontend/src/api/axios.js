/**
 * @file src/api/axios.js
 * @description Axios instance for all FinGuardAI API calls.
 *   - baseURL: '/api' in dev (Vite proxy), VITE_API_URL in production [P9]
 *   - withCredentials: true — sends the HTTP-only `token` cookie cross-site
 *   - timeout: 20 s (was 5 s) [P9]
 *   - Cold-start safety [P9]:
 *       • Before a state-changing request (POST/PATCH/PUT/DELETE), if the API
 *         has not answered for 10+ minutes it may be asleep, so wait for
 *         GET /health first. A mutation is therefore never sent into a
 *         sleeping server, where it could time out on the client yet still
 *         be processed after wake-up (→ duplicate transaction on resubmit).
 *       • A GET/HEAD that fails with no response / 502 / 503 / 504 waits for
 *         /health and is retried once. Mutations are never retried.
 *   - 401 → redirect to /login, except for the silent session probe
 *     (check-auth) and public pages. [P9 — C-P9-01]
 * @phase Phase 6 (original) → Phase 9 (deployment changes marked [P9])
 * @decision D-P6-03
 */
import axios from 'axios';
import { API_BASE_URL, API_TIMEOUT_MS } from './apiConfig.js';
import { markServerContact, msSinceServerContact, waitForServer } from './serverHealth.js';
import { getSessionSignal } from './session.js';
import { API_PATHS } from '../utils/constants.js';

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: API_TIMEOUT_MS,
  // AUD-31: no instance-wide 'Content-Type: application/json'. axios already
  // sends JSON for plain objects; a forced JSON header made axios serialise
  // FormData to JSON, so the profile image upload (multer) never got a file.
  // Without it, the browser sets multipart/form-data with the boundary.
});

const RETRYABLE_METHODS = new Set(['get', 'head']);
const COLD_START_STATUSES = new Set([502, 503, 504]);
const PUBLIC_PATHS = new Set(['/login', '/register']);
// Render free tier sleeps after 15 min without traffic; re-check a little earlier.
const POSSIBLY_ASLEEP_AFTER_MS = 10 * 60 * 1000;

const methodOf = (config) => (config?.method ?? 'get').toLowerCase();

/** True when the failure looks like "server asleep / booting", not a real API error. */
const isColdStartFailure = (error) =>
  !axios.isCancel(error) &&
  (!error.response || COLD_START_STATUSES.has(error.response.status));

// ─── Request Interceptor [P9] ─────────────────────────────────────────────────

api.interceptors.request.use(async (config) => {
  // AUD-40: tie the request to the current session so logout/login can cancel it
  config.signal ??= getSessionSignal();
  const isMutation = !RETRYABLE_METHODS.has(methodOf(config));
  if (isMutation && msSinceServerContact() > POSSIBLY_ASLEEP_AFTER_MS) {
    const ready = await waitForServer();
    if (!ready) {
      throw new axios.AxiosError(
        'The server is not reachable right now. Please try again in a moment.',
        axios.AxiosError.ERR_NETWORK,
        config,
      );
    }
  }
  return config;
});

// ─── Response Interceptor ─────────────────────────────────────────────────────

api.interceptors.response.use(
  (response) => {
    markServerContact(); // [P9]
    return response;
  },
  async (error) => {
    const config = error.config;

    // [P9] Any HTTP response (even 4xx) proves the server is awake
    if (error.response && !COLD_START_STATUSES.has(error.response.status)) {
      markServerContact();
    }

    // [P9] Cold start: wait for the server, then retry idempotent requests once.
    if (
      config &&
      isColdStartFailure(error) &&
      RETRYABLE_METHODS.has(methodOf(config)) &&
      !config.__coldStartRetried
    ) {
      config.__coldStartRetried = true;
      const ready = await waitForServer();
      if (ready) return api(config);
    }

    if (error.response?.status === 401) {
      // [P9 — C-P9-01] checkAuthThunk runs on every page load, including
      // /register. A 401 from that probe just means "not logged in" and is
      // handled by the auth slice; redirecting would make /register
      // unreachable for logged-out users.
      const isSessionProbe = config?.url === API_PATHS.AUTH.CHECK_AUTH;
      const onPublicPage = PUBLIC_PATHS.has(window.location.pathname);

      if (!isSessionProbe && !onPublicPage) {
        // Use window.location to avoid a circular import with the Redux store
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  },
);

export default api;
