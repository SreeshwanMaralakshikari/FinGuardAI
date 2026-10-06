// tests/units.test.js — pure unit tests (no database, no HTTP): date ranges, text
// normalisation, per-user lock, cookie options, image sniffing, token revocation.
import { describe, it, expect, afterEach } from '@jest/globals';
import { buildDateRange, parseDateBound } from '../utils/dateRange.js';
import { normalizeCategory, normalizeCity, formatRupees } from '../utils/normalize.js';
import { withUserLock, activeLockCount } from '../utils/userLock.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../config/cookieOptions.js';
import { detectImageType, getPublicIdFromUrl } from '../utils/imageUpload.js';
import { isTokenRevoked } from '../middleware/verifyToken.js';
import { getHourInAppZone, getYearInAppZone, getDayKeyInAppZone, zonedTimeToUtc, isValidTimeZone } from '../config/timeZone.js';
import { parsePagination } from '../utils/pagination.js';
import { isTransitionAllowed } from '../utils/caseWorkflow.js';
import { parseCookies } from '../utils/socketAuth.js';
import { checkFraud } from '../services/fraudDetectionService.js';

describe('L-05 date ranges (Asia/Kolkata days)', () => {
  it('YYYY-MM-DD means the whole IST day: start 00:00:00.000, end 23:59:59.999', () => {
    expect(parseDateBound('2026-10-05', 'start', 'startDate').toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(parseDateBound('2026-10-05', 'end', 'endDate').toISOString()).toBe('2026-10-05T18:29:59.999Z');
  });

  it('a single-day range covers a transaction made at 23:30 IST and excludes the next IST midnight', () => {
    const { $gte, $lte } = buildDateRange({ startDate: '2026-10-05', endDate: '2026-10-05' });
    const at = (iso) => new Date(iso).getTime();
    expect(at('2026-10-05T18:00:00Z')).toBeGreaterThanOrEqual($gte.getTime());   // 23:30 IST on the 5th
    expect(at('2026-10-05T18:00:00Z')).toBeLessThanOrEqual($lte.getTime());
    expect(at('2026-10-05T18:30:00Z')).toBeGreaterThan($lte.getTime());          // 00:00 IST on the 6th
    expect(at('2026-10-04T18:29:59Z')).toBeLessThan($gte.getTime());             // still the 4th in IST
  });

  it('full ISO strings with a time are used exactly as given', () => {
    const range = buildDateRange({ startDate: '2026-10-05T10:00:00+05:30', endDate: '2026-10-05T10:00:00.000Z' });
    expect(range.$gte.toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(range.$lte.toISOString()).toBe('2026-10-05T10:00:00.000Z');
  });

  it('returns null without bounds and ignores empty strings', () => {
    expect(buildDateRange({})).toBeNull();
    expect(buildDateRange({ startDate: '', endDate: '' })).toBeNull();
  });

  it('invalid values throw an error that errorHandler turns into HTTP 400', () => {
    for (const bad of ['abc', '2026-02-31', '2026-13-01', ['2026-01-01'], { a: 1 }]) {
      let error;
      try { buildDateRange({ startDate: bad }); } catch (e) { error = e; }
      expect(error?.status).toBe(400);
      expect(error.message).toMatch(/Invalid startDate/);
    }
  });
});

describe('N-11 business time zone helpers (independent of process.env.TZ)', () => {
  it('hour, year and day key are computed in Asia/Kolkata', () => {
    expect(getHourInAppZone('2026-01-15T11:00:00.000Z')).toBe(16);
    expect(getHourInAppZone('2026-01-15T18:30:00.000Z')).toBe(0);           // IST midnight → 0, never 24
    expect(getYearInAppZone('2025-12-31T19:00:00Z')).toBe(2026);            // 00:30 IST on 1 Jan
    expect(getDayKeyInAppZone(new Date('2025-12-31T19:00:00Z'))).toBe('2026-01-01');
    expect(zonedTimeToUtc(2026, 1, 1).toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('L-15 normalisation and formatting', () => {
  it('merchant categories: upper-case, spaces/punctuation removed, underscore kept', () => {
    expect(normalizeCategory(' Casi no ')).toBe('CASINO');
    expect(normalizeCategory('crypto_exchange')).toBe('CRYPTO_EXCHANGE');
    expect(normalizeCategory('Casino!!')).toBe('CASINO');
    expect(normalizeCategory(undefined)).toBe('');
  });

  it('cities: case-, space- and whitespace-insensitive', () => {
    expect(normalizeCity('  MUMBAI ')).toBe(normalizeCity('mumbai'));
    expect(normalizeCity('New   Delhi')).toBe(normalizeCity('new delhi'));
  });

  it('₹ amounts use Indian grouping and at most 2 decimals, whatever the server locale', () => {
    expect(formatRupees(999999999)).toBe('99,99,99,999');
    expect(formatRupees(1250000)).toBe('12,50,000');
    expect(formatRupees(13666.66667)).toBe('13,666.67');
    expect(formatRupees(750.5)).toBe('750.5');
  });
});

describe('L-15 pagination clamp', () => {
  it('a huge page number is clamped (no skip of 1e29)', () => {
    const { page, skip } = parsePagination({ page: '1e29', limit: '100' });
    expect(page).toBeLessThanOrEqual(100000);
    expect(skip).toBeLessThanOrEqual(100000 * 100);
    expect(parsePagination({ page: '99999999999999999999' }).page).toBe(100000);
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
  });
});

describe('L-08 withUserLock', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('serialises callers of the same key in arrival order and lets other keys run in parallel', async () => {
    const log = [];
    const job = (name, ms) => withUserLock('u1', async () => { log.push(`${name}:start`); await sleep(ms); log.push(`${name}:end`); });
    const other = withUserLock('u2', async () => { log.push('other'); });
    await Promise.all([job('a', 30), job('b', 5), job('c', 1), other]);
    expect(log.filter((e) => e !== 'other')).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(log.indexOf('other')).toBeLessThan(log.indexOf('a:end')); // different key did not wait
  });

  it('releases the lock when the callback throws, and returns the callback value', async () => {
    await expect(withUserLock('u3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withUserLock('u3', async () => 42)).resolves.toBe(42);
  });

  it('forgets idle keys (no memory growth)', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => withUserLock(`k${i}`, async () => i)));
    await Promise.all([withUserLock('same', async () => sleep(2)), withUserLock('same', async () => sleep(2))]);
    expect(activeLockCount()).toBe(0);
  });
});

describe('D-02 cookie options (COOKIE_MODE)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['NODE_ENV', 'COOKIE_MODE', 'COOKIE_DOMAIN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const set = (env) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  it('development / test: Lax, not Secure — COOKIE_MODE and COOKIE_DOMAIN are ignored', () => {
    set({ NODE_ENV: 'test', COOKIE_MODE: 'same-site', COOKIE_DOMAIN: '.example.com' });
    expect(getAuthCookieOptions()).toEqual({ httpOnly: true, path: '/', secure: false, sameSite: 'lax', maxAge: 6 * 60 * 60 * 1000 });
    expect(getClearAuthCookieOptions()).toEqual({ httpOnly: true, path: '/', secure: false, sameSite: 'lax' });
  });

  it('production default = cross-site: HttpOnly, Secure, SameSite=None, Partitioned', () => {
    set({ NODE_ENV: 'production', COOKIE_MODE: undefined, COOKIE_DOMAIN: undefined });
    expect(getAuthCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/' });
    set({ COOKIE_MODE: 'cross-site' });
    expect(getClearAuthCookieOptions()).toEqual({ httpOnly: true, path: '/', secure: true, sameSite: 'none', partitioned: true });
  });

  it('production same-site: HttpOnly, Secure, SameSite=Lax, no Partitioned; optional domain on both set and clear', () => {
    set({ NODE_ENV: 'production', COOKIE_MODE: 'Same-Site', COOKIE_DOMAIN: undefined });
    expect(getAuthCookieOptions()).toEqual({ httpOnly: true, path: '/', secure: true, sameSite: 'lax', maxAge: 6 * 60 * 60 * 1000 });
    expect(getAuthCookieOptions()).not.toHaveProperty('partitioned');
    set({ COOKIE_DOMAIN: '.example.com' });
    expect(getAuthCookieOptions()).toMatchObject({ domain: '.example.com', sameSite: 'lax', secure: true });
    expect(getClearAuthCookieOptions()).toEqual({ httpOnly: true, path: '/', secure: true, sameSite: 'lax', domain: '.example.com' });
  });

  it('cross-site mode ignores COOKIE_DOMAIN', () => {
    set({ NODE_ENV: 'production', COOKIE_MODE: 'cross-site', COOKIE_DOMAIN: '.example.com' });
    expect(getAuthCookieOptions()).not.toHaveProperty('domain');
  });
});

describe('N-09 image sniffing and Cloudinary ids', () => {
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]);
  it('recognises JPEG, PNG and WebP by their magic bytes only', () => {
    expect(detectImageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).toBe('webp');
  });
  it('rejects text, GIF, RIFF-but-not-WebP, empty and tiny buffers', () => {
    expect(detectImageType(Buffer.from('this is just a text file renamed to fake.png'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a' + 'x'.repeat(20)))).toBeNull();
    expect(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(undefined)).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
  it('derives the public_id of OUR uploads from the secure_url, and nothing else', () => {
    expect(getPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/v1712345678/finguardai/profiles/abc123.jpg')).toBe('finguardai/profiles/abc123');
    expect(getPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/finguardai/profiles/xyz.webp')).toBe('finguardai/profiles/xyz');
    expect(getPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/v1/other-app/photo.jpg')).toBeNull();
    expect(getPublicIdFromUrl('https://evil.example.com/image/upload/v1/finguardai/profiles/abc.jpg')).toBeNull();
    expect(getPublicIdFromUrl('')).toBeNull();
    expect(getPublicIdFromUrl(undefined)).toBeNull();
    expect(getPublicIdFromUrl('not a url')).toBeNull();
  });
});

describe('L-15 isTokenRevoked (exact, no grace period)', () => {
  const changedAt = new Date('2026-10-05T10:00:00.500Z');
  const user = { passwordChangedAt: changedAt };
  it('a user who never changed the password revokes nothing', () => {
    expect(isTokenRevoked({}, { iat: 1 })).toBe(false);
    expect(isTokenRevoked({ passwordChangedAt: null }, { iat: 1 })).toBe(false);
  });
  it('millisecond claim: issued before or AT the change → revoked; after → valid', () => {
    expect(isTokenRevoked(user, { iatMs: changedAt.getTime() - 1 })).toBe(true);
    expect(isTokenRevoked(user, { iatMs: changedAt.getTime() })).toBe(true);
    expect(isTokenRevoked(user, { iatMs: changedAt.getTime() + 1 })).toBe(false);
  });
  it('tokens without iatMs fall back to iat seconds: the change second itself counts as "before"', () => {
    expect(isTokenRevoked(user, { iat: Math.floor(changedAt.getTime() / 1000) })).toBe(true);
    expect(isTokenRevoked(user, { iat: Math.floor(changedAt.getTime() / 1000) - 5 })).toBe(true);
    expect(isTokenRevoked(user, { iat: Math.floor(changedAt.getTime() / 1000) + 1 })).toBe(false);
  });
});

describe('L-04 case transition table', () => {
  it('only ASSIGNED→UNDER_REVIEW|DISMISSED and UNDER_REVIEW→RESOLVED|DISMISSED are legal', () => {
    const all = ['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
    const legal = new Set(['ASSIGNED>UNDER_REVIEW', 'ASSIGNED>DISMISSED', 'UNDER_REVIEW>RESOLVED', 'UNDER_REVIEW>DISMISSED']);
    for (const from of all) {
      for (const to of all) expect(isTransitionAllowed(from, to)).toBe(legal.has(`${from}>${to}`));
    }
  });
});

describe('round 2 unit fixes', () => {
  it('an inverted date range is a 400; non-ISO strings are rejected', () => {
    let error;
    try { buildDateRange({ startDate: '2026-10-06', endDate: '2026-10-05' }); } catch (e) { error = e; }
    expect(error.status).toBe(400);
    expect(buildDateRange({ startDate: '2026-10-05', endDate: '2026-10-05' })).not.toBeNull();
    for (const bad of ['1', 'May 5', '2026/10/05', '2026-10-05 10:00']) {
      expect(() => parseDateBound(bad, 'start', 'startDate')).toThrow(/Invalid startDate/);
    }
    expect(parseDateBound('2026-10-05T10:00', 'start', 'startDate')).toBeInstanceOf(Date);
  });

  it('page above the cap is clamped', () => {
    expect(parsePagination({ page: '100001' }).page).toBe(100000);
  });

  it('parseCookies keeps the FIRST duplicate, like cookie-parser', () => {
    expect(parseCookies('token=first; a=1; token=second').token).toBe('first');
  });

  it('getPublicIdFromUrl returns null for a malformed percent-escape instead of throwing', () => {
    expect(getPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/v1/finguardai/profiles/%E0%A4%A.jpg')).toBeNull();
  });

  it('a transaction category with spaces matches a configured CRYPTO_EXCHANGE (and vice versa)', () => {
    const thresholds = {
      amountThreshold: 1e9, velocityLimit: { maxPerHour: 100, maxPerDay: 100 },
      scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 }, newDeviceWeight: 0,
      highRiskMerchants: ['CRYPTO_EXCHANGE'],
    };
    const base = {
      behaviorProfile: { knownDeviceIds: ['d'], avgTransactionAmount: 500, transactionVelocity: { perHour: 0, perDay: 0 }, usualLocations: ['Mumbai'], usualHours: Array.from({ length: 24 }, (_, i) => i) },
      deviceReputation: null, thresholds,
    };
    const txn = (merchantCategory) => ({ amount: 500, merchantCategory, merchantName: 'X', deviceId: 'd', location: { city: 'Mumbai', country: 'IN' }, timestamp: new Date('2026-01-15T11:00:00.000Z') });
    for (const c of ['crypto exchange', 'Crypto-Exchange', 'CRYPTO_EXCHANGE', ' crypto_exchange ']) {
      expect(checkFraud({ ...base, transaction: txn(c) }).fraudScore).toBe(35);
    }
    expect(checkFraud({ ...base, transaction: txn('retail') }).fraudScore).toBe(0);
  });
});

describe('round 2: zone-less date-times are India time', () => {
  it('2026-10-05T10:00 means 10:00 IST (04:30Z) whatever the host zone', () => {
    expect(parseDateBound('2026-10-05T10:00', 'start', 'startDate').toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(parseDateBound('2026-10-05T10:00:30.5', 'end', 'endDate').toISOString()).toBe('2026-10-05T04:30:30.500Z');
    expect(parseDateBound('2026-10-05T10:00:00Z', 'start', 'startDate').toISOString()).toBe('2026-10-05T10:00:00.000Z');
  });
});
