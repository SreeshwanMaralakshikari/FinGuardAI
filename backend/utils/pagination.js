/**
 * @file utils/pagination.js
 * @description Safe parsing of ?page= and ?limit= for every list endpoint (AUD-21).
 *   Before: `(Number(page) - 1) * Number(limit)` was used directly, so
 *     ?page=0   → negative skip → MongoDB error → HTTP 500
 *     ?page=abc → NaN skip     → HTTP 500
 *     ?limit=0  → no limit at all (whole collection) and pages: null
 *   Now: non-numeric / < 1 values fall back to the default, limit is
 *   capped at MAX_PAGE_LIMIT and page at MAX_PAGE (?page=1e29 used to give
 *   skip = 1e29, which real MongoDB rejects — L-15). Defaults keep the three tiers of D-P4-12
 *   (customer 10 · analyst/notifications 20 · admin 50).
 * @phase Phase 4 support — Phase 1–9 audit (round 2)
 */
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAGE = 100_000;

const toPositiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

/**
 * @param {Record<string, unknown>} query  req.query
 * @param {number} defaultLimit            tier default (10 | 20 | 50)
 * @returns {{ page: number, limit: number, skip: number }}
 */
export const parsePagination = (query = {}, defaultLimit = 10) => {
  const page = Math.min(toPositiveInt(query.page, 1), MAX_PAGE);
  const limit = Math.min(toPositiveInt(query.limit, defaultLimit), MAX_PAGE_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};
