/**
 * @file src/utils/caseAge.js
 * @description F-11: how long a case has been open, and its SLA level.
 *   level: 'ok' (< 24 h) | 'warn' (>= 24 h) | 'critical' (>= 72 h); closed cases never warn.
 */
export const SLA_WARN_HOURS = 24;
export const SLA_CRITICAL_HOURS = 72;

/** @param {number} ms @returns {string} "20 min" | "3 h 20 min" | "2 d 4 h" */
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/**
 * @param {{ status?: string, openedAt?: string, resolvedAt?: string|null }} c
 * @param {number} [now] epoch ms
 * @returns {{ text: string, level: 'ok'|'warn'|'critical'|'closed'|'unknown', ms: number }}
 */
export function caseAge(c, now = Date.now()) {
  const opened = new Date(c?.openedAt).getTime();
  if (Number.isNaN(opened)) return { text: '—', level: 'unknown', ms: 0 };
  if (c.status === 'RESOLVED' || c.status === 'DISMISSED') {
    const closedAt = c.resolvedAt ? new Date(c.resolvedAt).getTime() : NaN;
    if (Number.isNaN(closedAt)) return { text: 'Closed', level: 'closed', ms: 0 };
    return { text: `Closed after ${formatDuration(closedAt - opened)}`, level: 'closed', ms: closedAt - opened };
  }
  const ms = Math.max(0, now - opened);
  const hours = ms / 3600000;
  const level = hours >= SLA_CRITICAL_HOURS ? 'critical' : hours >= SLA_WARN_HOURS ? 'warn' : 'ok';
  return { text: `Open for ${formatDuration(ms)}`, level, ms };
}
