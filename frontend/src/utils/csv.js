/**
 * @file src/utils/csv.js
 * @description F-11: client-side CSV export of the rows currently loaded on a page.
 *   - RFC 4180 escaping: cells containing a comma, quote, CR or LF are wrapped in quotes, quotes doubled.
 *   - CSV-injection guard: a TEXT cell starting with = + - @ (or a tab / CR) gets a leading apostrophe,
 *     so Excel / Sheets never evaluate it as a formula. Real numbers are written as-is (a negative
 *     number is not a formula).
 *   - UTF-8 BOM so Excel opens ₹ and other non-ASCII text correctly; CRLF line endings.
 *   - File names carry the IST calendar date (Asia/Kolkata).
 */

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

/** @param {unknown} value @returns {string} one escaped CSV cell */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else {
    text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {Array<{ header: string, value: (row: object) => unknown }>} columns
 * @param {object[]} rows
 * @returns {string} CSV text starting with the BOM (header row + one line per row)
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** @param {Date} [now] @returns {string} "2026-10-12" — the calendar date in India */
export function istDateStamp(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** @param {string} prefix e.g. "flagged-transactions" @returns {string} "flagged-transactions-2026-10-12.csv" */
export const csvFileName = (prefix, now = new Date()) => `${prefix}-${istDateStamp(now)}.csv`;

/** Triggers a browser download of `text` (already BOM-prefixed by toCsv) as `fileName`. */
export function downloadCsv(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Convenience: build + download in one call. */
export function exportRowsToCsv(prefix, columns, rows) {
  downloadCsv(csvFileName(prefix), toCsv(columns, rows));
}
