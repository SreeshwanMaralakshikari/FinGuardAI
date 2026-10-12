// F-11: CSV util (escaping, formula-injection guard, BOM, IST file name) and case age / SLA
import { describe, it, expect } from 'vitest';
import { csvCell, toCsv, istDateStamp, csvFileName } from '../csv.js';
import { caseAge, formatDuration } from '../caseAge.js';
import { normaliseBreakdown } from '../scoreBreakdown.js';

describe('csvCell', () => {
  it('leaves plain text alone and blanks null / undefined / NaN', () => {
    expect(csvCell('Cafe')).toBe('Cafe');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(NaN)).toBe('');
    expect(csvCell(1200.5)).toBe('1200.5');
  });
  it('quotes commas, quotes and newlines, doubling inner quotes', () => {
    expect(csvCell('Shop, Pune')).toBe('"Shop, Pune"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });
  it('guards formula injection on text cells (= + - @ tab CR)', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+91 98')).toBe("'+91 98");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('=1,2')).toBe('"\'=1,2"'); // guard first, then quoting
  });
  it('does not alter real negative numbers or a mid-string "="', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('toCsv', () => {
  const cols = [{ header: 'Merchant', value: (r) => r.m }, { header: 'Amount (₹)', value: (r) => r.a }];
  it('starts with a UTF-8 BOM, uses CRLF and keeps ₹', () => {
    const text = toCsv(cols, [{ m: 'A, B', a: 10 }, { m: '=evil', a: 2 }]);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toBe('﻿Merchant,Amount (₹)\r\n"A, B",10\r\n\'=evil,2\r\n');
  });
  it('header-only output for no rows', () => {
    expect(toCsv(cols, [])).toBe('﻿Merchant,Amount (₹)\r\n');
  });
});

describe('file name', () => {
  it('uses the IST calendar date (UTC 20:00 is already the next day in India)', () => {
    expect(istDateStamp(new Date('2026-10-11T20:00:00Z'))).toBe('2026-10-12');
    expect(istDateStamp(new Date('2026-10-11T10:00:00Z'))).toBe('2026-10-11');
    expect(csvFileName('flagged-transactions', new Date('2026-10-11T20:00:00Z'))).toBe('flagged-transactions-2026-10-12.csv');
  });
});

describe('caseAge', () => {
  const now = new Date('2026-10-12T12:00:00Z').getTime();
  const at = (hoursAgo, extra = {}) => ({ status: 'UNDER_REVIEW', openedAt: new Date(now - Math.round(hoursAgo * 3600000)).toISOString(), ...extra });
  it('formats durations', () => {
    expect(formatDuration(20 * 60000)).toBe('20 min');
    expect(formatDuration((3 * 60 + 20) * 60000)).toBe('3 h 20 min');
    expect(formatDuration((26 * 60) * 60000)).toBe('1 d 2 h');
  });
  it('open cases: ok < 24 h, warn >= 24 h, critical >= 72 h', () => {
    expect(caseAge(at(200 / 60), now)).toMatchObject({ text: 'Open for 3 h 20 min', level: 'ok' });
    expect(caseAge(at(24), now).level).toBe('warn');
    expect(caseAge(at(71.9), now).level).toBe('warn');
    expect(caseAge(at(72), now).level).toBe('critical');
  });
  it('closed cases never warn and show the time to close', () => {
    const c = at(100, { status: 'RESOLVED', resolvedAt: new Date(now - 98 * 3600000).toISOString() });
    expect(caseAge(c, now)).toMatchObject({ text: 'Closed after 2 h 0 min', level: 'closed' });
  });
  it('invalid date is safe', () => {
    expect(caseAge({ status: 'OPEN', openedAt: 'x' }, now).level).toBe('unknown');
  });
});

describe('normaliseBreakdown', () => {
  it('handles empty / legacy / malformed input', () => {
    expect(normaliseBreakdown([]).rows).toEqual([]);
    expect(normaliseBreakdown(undefined).rows).toEqual([]);
    const r = normaliseBreakdown([{ rule: 'amount', label: 'Amount', points: 'x', max: 35 }, null, { rule: 'velocity', points: 5, max: 20 }]);
    expect(r.rows).toHaveLength(2);
    expect(r.total).toBe(5);
    expect(r.rows[1].label).toBe('velocity');
  });
});
