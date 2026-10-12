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
// Groups: 1 year · 2 month · 3 day · 4 hour · 5 minute · 6 second · 7 fraction · 8 zone (Z or ±hh[:]mm)
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

const badDate = (name) => {
  const error = new Error(`Invalid ${name}. Use YYYY-MM-DD or an ISO 8601 date-time.`);
  error.status = 400;
  return error;
};

/** True when year-month-day is a real calendar day (Date.UTC would silently roll 2026-02-30 over to March). */
const isRealCalendarDay = (year, month, day) => {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

/**
 * E-10: every component must be in range. 25:00, 10:99 and 2026-02-30T10:00 used to roll over
 * into a different window than the one typed (in the zoneless AND in the Z / offset form).
 */
const isRealDateTime = ([year, month, day, hour, minute, second = 0]) =>
  isRealCalendarDay(year, month, day) && hour <= 23 && minute <= 59 && second <= 59;

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
    if (!isRealCalendarDay(year, month, day)) throw badDate(name);
    return bound === 'start'
      ? zonedTimeToUtc(year, month, day, 0, 0, 0, 0)
      : zonedTimeToUtc(year, month, day, 23, 59, 59, 999);
  }

  // Only real ISO 8601 date-times: `new Date('1')` or `new Date('May 5')` would be accepted otherwise.
  const dateTime = ISO_DATE_TIME.exec(text);
  if (!dateTime) throw badDate(name);
  const [year, month, day, hour, minute] = dateTime.slice(1, 6).map(Number);
  const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  if (!isRealDateTime([year, month, day, hour, minute, second])) throw badDate(name);

  const zone = dateTime[8];
  let parsed;
  if (zone === undefined) {
    // A date-time without a zone ("2026-10-05T10:00") is India time, like the date-only form,
    // not whatever zone the server host happens to use.
    const millis = Number((dateTime[7] ?? '0').slice(0, 3).padEnd(3, '0'));
    parsed = zonedTimeToUtc(year, month, day, hour, minute, second, millis);
  } else {
    if (zone !== 'Z') {
      const offsetDigits = zone.slice(1).replace(':', '');
      if (Number(offsetDigits.slice(0, 2)) > 23 || Number(offsetDigits.slice(2)) > 59) throw badDate(name);
    }
    parsed = new Date(text);
  }
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
