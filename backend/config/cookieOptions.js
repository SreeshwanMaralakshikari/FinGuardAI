/**
 * @file config/cookieOptions.js
 * @description Environment-aware options for the HTTP-only JWT cookie (`token`).
 *
 *   Production, COOKIE_MODE=cross-site (DEFAULT — frontend on Vercel, API on
 *   Render: two different registrable sites):
 *     sameSite: 'none'   — the browser only attaches the cookie to cross-site
 *                          requests when SameSite=None
 *     secure:   true     — browsers reject SameSite=None without Secure
 *     partitioned: true  — CHIPS: keeps login working in browsers that block
 *                          unpartitioned third-party cookies (e.g. Chrome
 *                          Incognito). Ignored by browsers that don't support it.
 *     Safari/iOS may still refuse this third-party cookie (D-02).
 *
 *   Production, COOKIE_MODE=same-site (app and API under ONE registrable
 *   custom domain, e.g. app.example.com + api.example.com):
 *     sameSite: 'lax', secure: true, no Partitioned — a first-party cookie,
 *     which every browser (incl. Safari/iOS) accepts.
 *     COOKIE_DOMAIN (optional, e.g. ".example.com") scopes the cookie to the
 *     parent domain; leave it unset to bind the cookie to the API host only,
 *     which is enough when the browser talks to the API directly.
 *
 *   Development / test (any NODE_ENV other than 'production', Vite proxy →
 *   same origin): sameSite: 'lax', secure: false — works over plain
 *   http://localhost. COOKIE_MODE / COOKIE_DOMAIN are ignored there.
 *
 *   clearCookie() only deletes a cookie when path / domain / sameSite / secure /
 *   partitioned match the options it was set with, so both objects are
 *   derived from the same base.
 * @phase Phase 9 — Deployment (COOKIE_MODE added in the fix round, D-02)
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000; // must match jwt expiresIn: '6h'

export const COOKIE_MODES = Object.freeze(['cross-site', 'same-site']);

/** @returns {string} the raw configured mode (lower-cased), 'cross-site' when unset */
export const getCookieMode = () =>
  (process.env.COOKIE_MODE ?? '').trim().toLowerCase() || 'cross-site';

const baseCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    return { httpOnly: true, path: '/', secure: false, sameSite: 'lax' };
  }

  if (getCookieMode() === 'same-site') {
    const domain = (process.env.COOKIE_DOMAIN ?? '').trim();
    return {
      httpOnly: true,
      path: '/',
      secure: true,
      sameSite: 'lax',
      ...(domain ? { domain } : {}),
    };
  }

  // 'cross-site' (and, defensively, any value validateEnv would have rejected)
  return { httpOnly: true, path: '/', secure: true, sameSite: 'none', partitioned: true };
};

/** Options for res.cookie('token', jwt, ...) */
export const getAuthCookieOptions = () => ({
  ...baseCookieOptions(),
  maxAge: SIX_HOURS_MS,
});

/** Options for res.clearCookie('token', ...) — no maxAge/expires */
export const getClearAuthCookieOptions = () => baseCookieOptions();
