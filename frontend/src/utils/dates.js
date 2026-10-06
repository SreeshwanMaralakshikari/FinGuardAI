/**
 * @file src/utils/dates.js
 * @description Date-filter helpers. <input type="date"> yields "YYYY-MM-DD". The API parses
 *   that as midnight UTC and uses `$lte` for endDate, which would drop the whole end day and
 *   start days at 05:30 IST. We send explicit Asia/Kolkata bounds instead, so a one-day
 *   range really covers that IST day.
 */

/** "2026-10-05" → "2026-10-05T00:00:00+05:30" ('' stays '') */
export const istStartOfDay = (d) => (d ? `${d}T00:00:00.000+05:30` : '');

/** "2026-10-05" → "2026-10-05T23:59:59.999+05:30" ('' stays '') */
export const istEndOfDay = (d) => (d ? `${d}T23:59:59.999+05:30` : '');

/**
 * Build startDate/endDate query params from two date inputs (omits blanks).
 * @param {string} start
 * @param {string} end
 */
export function dateRangeParams(start, end) {
  const params = {};
  if (start) params.startDate = istStartOfDay(start);
  if (end) params.endDate = istEndOfDay(end);
  return params;
}
