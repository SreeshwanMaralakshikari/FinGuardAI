/**
 * @file config/timeZone.js
 * @description Single source of truth for the business time zone (AUD-06, N-11).
 *   FinGuardAI serves Indian customers, so "hour of day" everywhere — the
 *   unusual-hour fraud rule, behaviour profiles, fraud-by-hour analytics,
 *   daily trends, the year in public IDs and date-only API filters — must be
 *   India Standard Time, not the server's zone. Render servers run in UTC,
 *   which shifted every hour-based result by 5.5 h.
 *
 *   - config/loadEnv.js sets process.env.TZ to this value at startup
 *     (unconditionally, N-11) so logs and any stray local-time call agree.
 *   - Business code does NOT rely on process.env.TZ: it uses the helpers
 *     below, which format with Intl and APP_TIME_ZONE explicitly, so a host
 *     that presets TZ=UTC can never shift "unusual hour" results.
 *   - MongoDB date operators ($hour, $dateToString) receive the zone via the
 *     `timezone` option (AdminAPI analytics).
 *   Override with APP_TIME_ZONE (IANA name); validateEnv rejects invalid names.
 * @phase Phase 1–9 audit
 */
export const APP_TIME_ZONE = (process.env.APP_TIME_ZONE ?? '').trim() || 'Asia/Kolkata';

/** True when `name` is an IANA zone this runtime's Intl knows about. */
export const isValidTimeZone = (name) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

// Built lazily so an invalid APP_TIME_ZONE only breaks the helpers (and is
// reported clearly by validateEnv) instead of crashing module import.
let partsFormatter = null;
const getPartsFormatter = () => {
  partsFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return partsFormatter;
};

/**
 * Calendar/clock parts of an instant as seen in APP_TIME_ZONE.
 * @param {Date|number|string} date
 * @returns {{ year:number, month:number, day:number, hour:number, minute:number, second:number }}
 */
export const getZonedParts = (date) => {
  const parts = {};
  for (const { type, value } of getPartsFormatter().formatToParts(new Date(date))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour % 24, minute: parts.minute, second: parts.second, // h23, but guard "24"
  };
};

/** Hour of day (0–23) of an instant in APP_TIME_ZONE. */
export const getHourInAppZone = (date) => getZonedParts(date).hour;

/** Calendar year of an instant in APP_TIME_ZONE. */
export const getYearInAppZone = (date = new Date()) => getZonedParts(date).year;

/** Milliseconds that APP_TIME_ZONE is ahead of UTC at the given instant. */
const zoneOffsetMs = (instantMs) => {
  const p = getZonedParts(instantMs);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
};

/**
 * The UTC instant at which the given wall-clock time occurs in APP_TIME_ZONE.
 * (Two passes settle the offset around DST changes; IST has none.)
 * @returns {Date}
 */
export const zonedTimeToUtc = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) => {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = naive - zoneOffsetMs(naive);
  return new Date(naive - zoneOffsetMs(first));
};

/** YYYY-MM-DD key of an instant's calendar day in APP_TIME_ZONE. */
export const getDayKeyInAppZone = (date = new Date()) => {
  const { year, month, day } = getZonedParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
