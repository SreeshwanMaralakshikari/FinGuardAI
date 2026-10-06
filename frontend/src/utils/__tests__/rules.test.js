import { describe, it, expect } from 'vitest';
import { resolvePostLogin } from '../navigation.js';
import { isValidEmail, validateName, validatePasswordBytes } from '../forms.js';
import { assertBuildApiUrl } from '../../../vite.config.js';

describe('resolvePostLogin (N-17)', () => {
  it('honours a location inside the role area, keeping search and hash', () => {
    expect(resolvePostLogin('ANALYST', { pathname: '/analyst/cases/1', search: '?a=1', hash: '#x' }))
      .toBe('/analyst/cases/1?a=1#x');
    expect(resolvePostLogin('CUSTOMER', '/customer/profile')).toBe('/customer/profile');
  });
  it('falls back to the role home otherwise', () => {
    expect(resolvePostLogin('CUSTOMER', { pathname: '/admin/users' })).toBe('/customer');
    expect(resolvePostLogin('CUSTOMER', { pathname: '/customerx' })).toBe('/customer');
    expect(resolvePostLogin('ADMIN', { pathname: '//evil.com' })).toBe('/admin');
    expect(resolvePostLogin('ADMIN', { pathname: '/login' })).toBe('/admin');
    expect(resolvePostLogin('ADMIN', undefined)).toBe('/admin');
    expect(resolvePostLogin('NOPE', { pathname: '/admin' })).toBe('/');
  });
});

describe('isValidEmail / validateName (N-16)', () => {
  it('accepts normal and rejects malformed emails', () => {
    expect(isValidEmail('a.b+c@example.co.in')).toBe(true);
    for (const bad of ['', 'a@b', 'a@@b.com', '.a@b.com', 'a..b@b.com', 'a@b.c', 'a b@c.com', null])
      expect(isValidEmail(bad)).toBe(false);
  });
  it('validates name length after trimming', () => {
    expect(validateName('  ')).toBe('Name is required');
    expect(validateName(' a ')).toMatch(/at least 2/);
    expect(validateName('x'.repeat(101))).toMatch(/exceed 100/);
    expect(validateName(' Ab ')).toBe(true);
  });
});

describe('assertBuildApiUrl', () => {
  it('accepts a bare https origin', () => {
    expect(() => assertBuildApiUrl('https://api.example.com', 'production')).not.toThrow();
  });
  it.each(['', 'http://api.example.com', 'https://a.com/', 'https://a.com/api', 'https://a.com?x=1',
    'https://u:p@a.com', 'not a url', 'http://localhost:5000',
    'https://api.example.com?', 'https://api.example.com#', 'HTTPS://API.EXAMPLE.COM', 'https://api.example.com:443'])('rejects %j in production', (v) => {
    expect(() => assertBuildApiUrl(v, 'production')).toThrow();
  });
  it('allows http localhost outside production only', () => {
    expect(() => assertBuildApiUrl('http://localhost:5000', 'staging')).not.toThrow();
  });
});

describe('validatePasswordBytes (server counts 72 BYTES)', () => {
  it('accepts 72 ASCII characters and rejects 73', () => {
    expect(validatePasswordBytes('a'.repeat(72))).toBe(true);
    expect(validatePasswordBytes('a'.repeat(73))).toBe('Password cannot exceed 72 characters');
  });
  it('counts multi-byte characters: 36 × "é" is 72 bytes, 37 is too long', () => {
    expect(validatePasswordBytes('é'.repeat(36))).toBe(true);
    expect(validatePasswordBytes('é'.repeat(37))).toMatch(/72 bytes/);
  });
});
