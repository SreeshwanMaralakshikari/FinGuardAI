/**
 * @file utils/dateRange.js
 * @description One parser for the startDate / endDate query filters of every
 *   endpoint (L-05 / AA-9 / BE-19).
 *
 *   Before: `new Date('2026-10-05')` is midnight UTC and the end bound used
 *   `$lte`, so a single-day range ("2026-10-05" to "2026-10-05") matched
 *   nothing, and day boundaries were UTC instead of India time.
 *
 *   Now:
 *     • 'YYYY-MM-DD' is a calendar day in APP_TIME_ZONE (Asia/Kolkata):
 *         start → 00:00:00.000 of that day, end → 23:59:59.999 of that day.
 *     • Anything else (a full ISO string such as 2026-10-05T10:00:00+05:30) is
 *       used exactly as given.
 *     • Invalid values throw an error with status 400 (errorHandler → 400).
 */
import { zonedTimeToUtc } from '../config/timeZone.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO 8601 date-time with an optional zone: 2026-10-05T10:00, 2026-10-05T10:00:00.000Z, …+05:30
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const badDate = (name) => {
  const error = new Error(`Invalid ${name}. Use YYYY-MM-DD or an ISO 8601 date-time.`);
  error.status = 400;
  return error;
};

/**
 * @param {unknown} value  raw query-string value
 * @param {'start'|'end'} bound
 * @param {string} name    parameter name used in the error message
 * @returns {Date}
 */
export const parseDateBound = (value, bound, name = 'date') => {
  if (typeof value !== 'string' || !value.trim()) throw badDate(name);
  const text = value.trim();

  const match = DATE_ONLY.exec(text);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    // Reject 2026-02-31 and the like (Date.UTC would silently roll over).
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw badDate(name);
    }
    return bound === 'start'
      ? zonedTimeToUtc(year, month, day, 0, 0, 0, 0)
      : zonedTimeToUtc(year, month, day, 23, 59, 59, 999);
  }

  // Only real ISO 8601 date-times: `new Date('1')` or `new Date('May 5')` would be accepted otherwise.
  if (!ISO_DATE_TIME.test(text)) throw badDate(name);
  // A date-time without a zone ("2026-10-05T10:00") is India time, like the date-only form,
  // not whatever zone the server host happens to use.
  const zoneless = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/.exec(text);
  const parsed = zoneless
    ? zonedTimeToUtc(+zoneless[1], +zoneless[2], +zoneless[3], +zoneless[4], +zoneless[5], +(zoneless[6] ?? 0),
      +((zoneless[7] ?? '0').padEnd(3, '0')))
    : new Date(text);
  if (Number.isNaN(parsed.getTime())) throw badDate(name);
  return parsed;
};

/**
 * Builds a `{ $gte?, $lte? }` range from req.query.startDate / endDate.
 * @param {Record<string, unknown>} query  req.query
 * @returns {{ $gte?: Date, $lte?: Date } | null}  null when neither bound is present
 */
export const buildDateRange = (query = {}) => {
  const { startDate, endDate } = query;
  const range = {};
  if (startDate !== undefined && startDate !== '') range.$gte = parseDateBound(startDate, 'start', 'startDate');
  if (endDate !== undefined && endDate !== '') range.$lte = parseDateBound(endDate, 'end', 'endDate');
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    const error = new Error('startDate must not be after endDate.');
    error.status = 400;
    throw error;
  }
  return Object.keys(range).length > 0 ? range : null;
};
