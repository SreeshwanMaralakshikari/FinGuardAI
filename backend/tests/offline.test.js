// tests/offline.test.js — offline kit: backend/.env.offline generation and the Atlas → local copy guard.
import { describe, expect, it } from '@jest/globals';
import { parseEnv } from 'node:util';
import dotenv from 'dotenv';
import { buildOfflineEnv, OFFLINE_DB_URI, OFFLINE_ML_URL } from '../scripts/offlineSetup.mjs';
import { assertCopyTargets } from '../scripts/copyAtlasToLocal.mjs';
import { getMlSettings } from '../config/mlSettings.js';

const LIVE = {
  ADMIN_EMAIL: 'admin@finguard.test',
  ADMIN_NAME: 'FinGuardAI Admin',
  ADMIN_PASSWORD: 'Str0ng-Admin-Pass!',
  ANALYST_INVITE_CODE: 'invite-code-123',
  MONGODB_URI: 'mongodb+srv://u:secret@c.mongodb.net/finguardai',
};

// The scripts start Node with --env-file (parsed by Node) and the app also runs dotenv: both must agree.
const bothParsers = (text) => {
  const node = parseEnv(text);
  const viaDotenv = dotenv.parse(text);
  expect(node).toEqual(viaDotenv);
  return node;
};

describe('offline setup (.env.offline)', () => {
  it('points at local MongoDB and the local ML service, in development mode', () => {
    const env = bothParsers(buildOfflineEnv(LIVE).text);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: '5000',
      MONGODB_URI: OFFLINE_DB_URI,
      FRONTEND_URL: 'http://localhost:3000',
      ML_ENABLED: 'true',
      ML_SERVICE_URL: OFFLINE_ML_URL,
      API_URL: 'http://127.0.0.1:5000',
    });
    expect(env.MONGODB_URI).toBe('mongodb://127.0.0.1:27017/finguardai_offline');
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{96}$/);
    expect(env.ML_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(getMlSettings(env).enabled).toBe(true); // the backend accepts http://127.0.0.1 in development
  });

  it('keeps the live admin login and invite code, so the same accounts work offline', () => {
    const { text, generatedAdmin } = buildOfflineEnv(LIVE);
    expect(generatedAdmin).toBeNull();
    expect(bothParsers(text)).toMatchObject({
      ADMIN_EMAIL: LIVE.ADMIN_EMAIL, ADMIN_NAME: LIVE.ADMIN_NAME, ADMIN_PASSWORD: LIVE.ADMIN_PASSWORD, ANALYST_INVITE_CODE: LIVE.ANALYST_INVITE_CODE,
    });
    expect(text).not.toContain(LIVE.MONGODB_URI); // the Atlas link is never copied
  });

  it.each([
    'pass with spaces',
    'has#hash',
    'quote"inside',
    'back\\slash\\n',
    "it's-mine",
    'dollar$HOME=x',
  ])('a password like %j reaches the app unchanged', (password) => {
    const env = bothParsers(buildOfflineEnv({ ...LIVE, ADMIN_PASSWORD: password }).text);
    expect(env.ADMIN_PASSWORD).toBe(password);
  });

  it('without a .env it makes a local admin and invite code', () => {
    const { text, generatedAdmin } = buildOfflineEnv({});
    const env = bothParsers(text);
    expect(generatedAdmin.email).toBe('admin@finguard.local');
    expect(env.ADMIN_PASSWORD).toBe(generatedAdmin.password);
    expect(env.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(12);
    expect(env.ANALYST_INVITE_CODE.length).toBeGreaterThanOrEqual(8);
  });

  it('new secrets every time', () => {
    const a = parseEnv(buildOfflineEnv(LIVE).text);
    const b = parseEnv(buildOfflineEnv(LIVE).text);
    expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET);
    expect(a.ML_API_KEY).not.toBe(b.ML_API_KEY);
  });
});

describe('Atlas → local copy guard', () => {
  const local = 'mongodb://127.0.0.1:27017/finguardai_offline';

  it('accepts live → local', () => {
    expect(() => assertCopyTargets(LIVE.MONGODB_URI, local)).not.toThrow();
    expect(() => assertCopyTargets(LIVE.MONGODB_URI, 'mongodb://localhost:27017/finguardai_offline')).not.toThrow();
  });

  it('never overwrites a remote database', () => {
    expect(() => assertCopyTargets(local, LIVE.MONGODB_URI)).toThrow(/must be on this machine/);
  });

  it('needs both databases, named, and different', () => {
    expect(() => assertCopyTargets('', local)).toThrow(/backend\/\.env/);
    expect(() => assertCopyTargets(LIVE.MONGODB_URI, '')).toThrow(/offline:setup/);
    expect(() => assertCopyTargets(LIVE.MONGODB_URI, 'mongodb://127.0.0.1:27017')).toThrow(/must name a database/);
    expect(() => assertCopyTargets('mongodb+srv://u:p@c.mongodb.net/', local)).toThrow(/no database name/);
    expect(() => assertCopyTargets(local, local)).toThrow(/same database/);
  });
});
