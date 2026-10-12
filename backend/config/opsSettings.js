/**
 * @file config/opsSettings.js
 * @description C-04 / C-08: operational limits read from the environment, in ONE place.
 *   Pure functions of `env` (default process.env) so models, services, validateEnv and tests share
 *   the same parsing. Models call these at import time, BEFORE validateEnv() has run, so the parsers
 *   never throw: an unusable value falls back to the default and validateEnv() reports it (fail-fast).
 */
const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_DAYS = 36_500; // 100 years — keeps expireAfterSeconds far below the 32-bit limit

export const DEFAULT_NOTIFICATION_TTL_DAYS = 90;
export const DEFAULT_MAX_DEVICES_PER_USER = 20;

/**
 * @param {string|undefined} raw
 * @returns {{ ok: boolean, set: boolean, value: number }}  `set` = the variable holds a non-blank value;
 *   `ok` = it is a whole number 0..MAX_DAYS ("007" and "1e3" are rejected on purpose)
 */
const parseWholeNumber = (raw, max) => {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, set: false, value: NaN };
  if (!/^\d{1,9}$/.test(text)) return { ok: false, set: true, value: NaN };
  const value = Number(text);
  return { ok: value <= max, set: true, value };
};

/** NOTIFICATION_TTL_DAYS → seconds for the TTL index, or null when disabled (0). Default 90 days. */
export const getNotificationTtlSeconds = (env = process.env) => {
  const parsed = parseWholeNumber(env.NOTIFICATION_TTL_DAYS, MAX_DAYS);
  const days = parsed.set && parsed.ok ? parsed.value : DEFAULT_NOTIFICATION_TTL_DAYS;
  return days === 0 ? null : days * SECONDS_PER_DAY;
};

/** AUDIT_LOG_TTL_DAYS → seconds, or null (default: audit entries are kept forever; 0 or unset = no TTL). */
export const getAuditLogTtlSeconds = (env = process.env) => {
  const parsed = parseWholeNumber(env.AUDIT_LOG_TTL_DAYS, MAX_DAYS);
  if (!parsed.set || !parsed.ok || parsed.value === 0) return null;
  return parsed.value * SECONDS_PER_DAY;
};

/** MAX_DEVICES_PER_USER → positive integer, default 20. */
export const getMaxDevicesPerUser = (env = process.env) => {
  const parsed = parseWholeNumber(env.MAX_DEVICES_PER_USER, 1_000_000);
  return parsed.set && parsed.ok && parsed.value >= 1 ? parsed.value : DEFAULT_MAX_DEVICES_PER_USER;
};

/** Problems with these variables, for validateEnv(). @returns {string[]} */
export const validateOpsSettings = (env = process.env) => {
  const problems = [];
  const ttl = parseWholeNumber(env.NOTIFICATION_TTL_DAYS, MAX_DAYS);
  if (ttl.set && !ttl.ok) {
    problems.push(`NOTIFICATION_TTL_DAYS must be a whole number of days between 0 and ${MAX_DAYS} (0 disables the TTL; got "${env.NOTIFICATION_TTL_DAYS}")`);
  }
  const audit = parseWholeNumber(env.AUDIT_LOG_TTL_DAYS, MAX_DAYS);
  if (audit.set && !audit.ok) {
    problems.push(`AUDIT_LOG_TTL_DAYS must be a whole number of days between 1 and ${MAX_DAYS} (unset or 0 keeps audit entries forever; got "${env.AUDIT_LOG_TTL_DAYS}")`);
  }
  const devices = parseWholeNumber(env.MAX_DEVICES_PER_USER, 1_000_000);
  if (devices.set && (!devices.ok || devices.value < 1)) {
    problems.push(`MAX_DEVICES_PER_USER must be a positive whole number (got "${env.MAX_DEVICES_PER_USER}")`);
  }
  return problems;
};
