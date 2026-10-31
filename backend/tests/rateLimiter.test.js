// tests/rateLimiter.test.js — express-rate-limit 8: per-user keys with an IPv6-safe IP fallback.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import rateLimit from 'express-rate-limit';
import { userOrIpKey } from '../middleware/rateLimiter.js';

afterEach(() => { jest.restoreAllMocks(); });

describe('userOrIpKey', () => {
  it('uses the signed-in user id first', () => {
    expect(userOrIpKey({ user: { _id: 'abc123' }, ip: '203.0.113.7' })).toBe('user:abc123');
  });

  it('falls back to an IPv4 address unchanged', () => {
    expect(userOrIpKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by their /56 network, so rotating addresses in one block shares one limit', () => {
    const a = userOrIpKey({ ip: '2001:db8:1234:5611:1111:1111:1111:1111' });
    const b = userOrIpKey({ ip: '2001:db8:1234:56ff:2222:2222:2222:2222' });
    const other = userOrIpKey({ ip: '2001:db8:1234:5700::1' });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(userOrIpKey({ ip: '::ffff:203.0.113.7' })).toBe('203.0.113.7');
  });

  it('copes with a missing IP', () => {
    expect(userOrIpKey({})).toBe('');
  });
});

describe('limiter configuration', () => {
  it('passes express-rate-limit 8 validation (no IPv6 key-generator warning)', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
    rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: userOrIpKey });
    const logged = [...errors.mock.calls, ...warnings.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toMatch(/ERR_ERL/);
  });

  it('a key generator that uses req.ip directly WOULD be flagged (the check above is meaningful)', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    rateLimit({ windowMs: 60_000, limit: 5, keyGenerator: (req) => req.ip });
    expect(errors.mock.calls.flat().map(String).join('\n')).toMatch(/ERR_ERL_KEY_GEN_IPV6/);
  });
});
