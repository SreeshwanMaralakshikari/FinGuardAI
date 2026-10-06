/**
 * @file src/api/apiConfig.js
 * @description Single source of truth for where the frontend talks to the backend.
 *
 *   Development (`npm run dev`, import.meta.env.DEV === true):
 *     API    → '/api'                 (Vite proxy → http://localhost:5000, prefix stripped)
 *     Socket → window.location.origin (Vite proxy forwards /socket.io with ws: true)
 *     Same origin, so no CORS and the cookie is first-party.
 *
 *   Production (`vite build` on Vercel):
 *     API    → VITE_API_URL           e.g. https://finguardai-api.onrender.com
 *     Socket → VITE_SOCKET_URL, falling back to VITE_API_URL (same Render service)
 *
 *   VITE_* values are inlined at BUILD time. Changing them in the Vercel
 *   dashboard has no effect until you redeploy.
 * @phase Phase 9 — Deployment
 */

const stripTrailingSlash = (url = '') => url.replace(/\/+$/, '');

const isDev = import.meta.env.DEV;

/** Base URL for every axios request. */
export const API_BASE_URL = isDev
  ? '/api'
  : stripTrailingSlash(import.meta.env.VITE_API_URL);

/** Origin passed to socket.io-client's io(). */
export const SOCKET_URL = isDev
  ? window.location.origin
  : stripTrailingSlash(import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL);

/**
 * Per-request timeout. Phase 6 used 5 s, which is shorter than a Render
 * free-tier cold start, so the first request after an idle period always
 * failed. 20 s covers slow requests; cold starts are handled by
 * serverHealth.waitForServer().
 */
export const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 20_000;

/** Backend health endpoint (GET /health — Phase 9 app.js). */
export const HEALTH_URL = `${API_BASE_URL}/health`;
