/**
 * @file config/corsOptions.js
 * @description Single source of truth for which browser origins may call the API.
 *   Shared by Express (cors middleware), the CSRF origin guard, and Socket.io,
 *   so the three can never drift apart.
 *
 *   FRONTEND_URL may hold one origin or a comma-separated list, e.g.
 *     FRONTEND_URL=https://finguardai.vercel.app
 *     FRONTEND_URL=https://finguardai.vercel.app,https://finguardai-git-dev-sreeshwan.vercel.app
 *
 *   The list is read from process.env on every call (not cached at import time)
 *   so module import order can never produce an empty allowlist.
 * @phase Phase 9 — Deployment
 */

import { isProductionLike } from './environment.js';

const DEV_DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/**
 * @returns {string[]} normalised list of allowed origins (no trailing slashes)
 */
export const getAllowedOrigins = () => {
  const fromEnv = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (isProductionLike()) return fromEnv; // D-03: localhost origins only for NODE_ENV=development|test
  return [...new Set([...fromEnv, ...DEV_DEFAULT_ORIGINS])];
};

/**
 * @param {string|undefined} origin — value of the request's Origin header
 * @returns {boolean}
 */
export const isOriginAllowed = (origin) =>
  Boolean(origin) && getAllowedOrigins().includes(origin);

/**
 * Options object for the `cors` package (Express) and Socket.io's `cors` key.
 *   - Requests with NO Origin header (curl, Render health checks,
 *     server-to-server) are allowed: CORS is a browser-only mechanism.
 *   - Disallowed browser origins get no CORS headers → the browser blocks
 *     the response. We pass `false` (not an Error) so a stray origin does not
 *     turn into a 500 in the logs.
 */
export const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isOriginAllowed(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true, // required for the HTTP-only `token` cookie
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'], // C-01: the browser preflight must accept the retry-safety header
  // D-06: without this a browser hides the rate-limit headers from JavaScript, so the UI
  // could not tell a 429 user how long to wait.
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 600, // cache preflight responses for 10 minutes
};
