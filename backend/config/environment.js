/**
 * @file config/environment.js
 * @description D-03: secure by default. The server counts as "production-like"
 *   (Secure cookies, no localhost CORS origins, no raw error messages in 500s,
 *   production env checks) UNLESS NODE_ENV is explicitly 'development' or 'test'.
 *   A host that forgets NODE_ENV therefore fails safe instead of running with the
 *   development relaxations. Local development: put NODE_ENV=development in .env
 *   (see .env.example); `npm test` sets NODE_ENV=test itself (tests/env.js).
 *   Read from process.env on every call (never cached), like config/corsOptions.js.
 */
const RELAXED_ENVIRONMENTS = ['development', 'test'];

/** @returns {boolean} true when NODE_ENV is exactly 'development' or 'test' (case-insensitive) */
export const isDevelopmentOrTest = () =>
  RELAXED_ENVIRONMENTS.includes((process.env.NODE_ENV ?? '').trim().toLowerCase());

/** @returns {boolean} true unless NODE_ENV is 'development' or 'test' (unset counts as production-like) */
export const isProductionLike = () => !isDevelopmentOrTest();

/**
 * The mode the server actually runs in, for logs: 'development' | 'test' | 'production', or 'production-like (…)' when
 * NODE_ENV is unset or something else (D-03 treats those as production, so a log must never say "development" for them).
 */
export const describeEnvironment = () => {
  const raw = (process.env.NODE_ENV ?? '').trim();
  const name = raw.toLowerCase();
  if (RELAXED_ENVIRONMENTS.includes(name) || name === 'production') return name;
  return raw ? `production-like (NODE_ENV="${raw}")` : 'production-like (NODE_ENV not set)';
};
