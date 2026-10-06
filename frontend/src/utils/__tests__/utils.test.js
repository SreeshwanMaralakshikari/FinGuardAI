import { describe, it, expect, beforeEach } from 'vitest';
import { istStartOfDay, istEndOfDay, dateRangeParams } from '../dates.js';
import { getNestedError, stripBlank } from '../forms.js';
import { getDeviceId } from '../device.js';
import { ROLE_HOME, STATUS_TRANSITIONS } from '../constants.js';
import { CUSTOMER_NAV, ANALYST_NAV, ADMIN_NAV } from '../navigation.js';
import { formatDate, formatDateShort } from '../common.js';

describe('dates', () => {
  it('builds IST day bounds', () => {
    expect(istStartOfDay('2026-10-05')).toBe('2026-10-05T00:00:00.000+05:30');
    expect(istEndOfDay('2026-10-05')).toBe('2026-10-05T23:59:59.999+05:30');
    expect(istStartOfDay('')).toBe('');
  });
  it('omits blank range params', () => {
    expect(dateRangeParams('', '')).toEqual({});
    expect(dateRangeParams('2026-10-01', '')).toEqual({ startDate: '2026-10-01T00:00:00.000+05:30' });
  });
  it('formatters tolerate invalid input', () => {
    expect(formatDate('nope')).toBe('—');
    expect(formatDateShort(undefined)).toBe('—');
  });
});

describe('forms', () => {
  it('getNestedError walks dotted paths', () => {
    const errors = { a: { b: { message: 'x' } } };
    expect(getNestedError(errors, 'a.b')).toEqual({ message: 'x' });
    expect(getNestedError(errors, 'a.c')).toBeUndefined();
  });
  it('stripBlank removes empty strings and empty objects but keeps zero/false', () => {
    expect(stripBlank({ a: ' ', b: 'x ', c: { d: '' }, e: 0, f: false, g: null }))
      .toEqual({ b: 'x', e: 0, f: false });
    expect(stripBlank({ a: '' })).toBeUndefined();
  });
});

describe('device id', () => {
  beforeEach(() => localStorage.clear());
  it('is stable across calls', () => {
    const a = getDeviceId();
    expect(a).toMatch(/^web-/);
    expect(getDeviceId()).toBe(a);
  });
});

describe('navigation and constants', () => {
  it('every nav link lives under its role home', () => {
    CUSTOMER_NAV.forEach((n) => expect(n.to.startsWith(ROLE_HOME.CUSTOMER)).toBe(true));
    ANALYST_NAV.forEach((n) => expect(n.to.startsWith(ROLE_HOME.ANALYST)).toBe(true));
    ADMIN_NAV.forEach((n) => expect(n.to.startsWith(ROLE_HOME.ADMIN)).toBe(true));
  });
  it('closed case statuses have no transitions', () => {
    expect(STATUS_TRANSITIONS.RESOLVED).toEqual([]);
    expect(STATUS_TRANSITIONS.DISMISSED).toEqual([]);
    expect(STATUS_TRANSITIONS.ASSIGNED).toContain('UNDER_REVIEW');
  });
});
