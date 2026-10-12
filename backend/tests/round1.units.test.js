// tests/round1.units.test.js — fix round 1, unit level (no HTTP). Most cases need no database.
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import validateEnv from '../config/validateEnv.js';
import { assertSeedConfig } from '../seed/seedAdmin.js';
import { parseDateBound, buildDateRange } from '../utils/dateRange.js';
import { ensureIndexes } from '../config/db.js';
import { registerProcessErrorHandlers } from '../utils/processHandlers.js';
import { getProfileUploadOptions } from '../utils/imageUpload.js';
import { isTokenRevoked } from '../middleware/verifyToken.js';
import { isProductionLike, isDevelopmentOrTest } from '../config/environment.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../config/cookieOptions.js';
import { corsOptions } from '../config/corsOptions.js';
import * as enums from '../utils/enums.js';
import UserModel from '../models/UserModel.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { connectTestDB, disconnectTestDB } from './setup.js';

const ENV_KEYS = [
  'NODE_ENV', 'RENDER', 'MONGODB_URI', 'JWT_SECRET', 'FRONTEND_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET', 'APP_TIME_ZONE', 'COOKIE_MODE', 'COOKIE_DOMAIN', 'ANALYST_INVITE_CODE', 'PORT',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
const setEnv = (env) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
let warnSpy;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); restoreEnv(); });

const dev = () => ({
  NODE_ENV: 'development', RENDER: undefined, MONGODB_URI: 'mongodb://127.0.0.1:27017/finguardai_dev', JWT_SECRET: 'x'.repeat(40),
  FRONTEND_URL: undefined, CLOUDINARY_CLOUD_NAME: undefined, CLOUDINARY_API_KEY: undefined, CLOUDINARY_API_SECRET: undefined,
  PORT: undefined, ANALYST_INVITE_CODE: undefined, APP_TIME_ZONE: undefined, COOKIE_MODE: undefined, COOKIE_DOMAIN: undefined,
});
const validate = (overrides = {}) => { setEnv({ ...dev(), ...overrides }); return () => validateEnv(); };

describe('D-03 environment helpers', () => {
  it('only an explicit development / test NODE_ENV is relaxed', () => {
    const results = {};
    for (const value of [undefined, '', 'production', 'staging', 'Production', 'development', 'Development', 'test', ' test ']) {
      setEnv({ NODE_ENV: value });
      results[String(value)] = [isDevelopmentOrTest(), isProductionLike()];
    }
    expect(results).toEqual({
      undefined: [false, true], '': [false, true], production: [false, true], staging: [false, true], Production: [false, true],
      development: [true, false], Development: [true, false], test: [true, false], ' test ': [true, false],
    });
  });

  it('cookie options: Secure / SameSite=None unless NODE_ENV is development or test', () => {
    setEnv({ NODE_ENV: undefined, COOKIE_MODE: undefined });
    expect(getAuthCookieOptions()).toMatchObject({ secure: true, sameSite: 'none', partitioned: true });
    expect(getClearAuthCookieOptions()).toMatchObject({ secure: true, sameSite: 'none' });
    setEnv({ NODE_ENV: 'staging' });
    expect(getAuthCookieOptions().secure).toBe(true);
    for (const relaxed of ['development', 'test']) {
      setEnv({ NODE_ENV: relaxed });
      expect(getAuthCookieOptions()).toMatchObject({ secure: false, sameSite: 'lax' });
    }
  });

  it('validateEnv: an unset NODE_ENV applies production rules and says how to opt into development', () => {
    expect(validate({ NODE_ENV: undefined })).toThrow(/FRONTEND_URL is missing[\s\S]*NODE_ENV is not set[\s\S]*NODE_ENV=development/);
    expect(validate({ NODE_ENV: 'development' })).not.toThrow(); // what a local .env sets: nothing breaks
    expect(validate({ NODE_ENV: 'test' })).not.toThrow();
    expect(validate({ NODE_ENV: 'staging' })).toThrow(/FRONTEND_URL is missing/);
    // Render must still work: production with every variable set is accepted, and Render without it is refused.
    const production = {
      NODE_ENV: 'production', FRONTEND_URL: 'https://app.example.com', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
      MONGODB_URI: 'mongodb+srv://u:p@cluster0.mongodb.net/finguardai?retryWrites=true',
    };
    expect(validate({ ...production, RENDER: 'true' })).not.toThrow();
    expect(validate({ ...production, RENDER: 'true', NODE_ENV: undefined })).toThrow(/NODE_ENV must be "production" on Render/);
    expect(validate({ ...production, RENDER: 'true', NODE_ENV: 'development' })).toThrow(/NODE_ENV must be "production" on Render/);
  });
});

describe('D-10 PORT and ANALYST_INVITE_CODE', () => {
  it('PORT must be an integer from 1 to 65535 when set', () => {
    for (const PORT of ['abc', '0', '65536', '80.5', '-1', '1e3', '5000x', ' 70000 ']) {
      expect(validate({ PORT })).toThrow(/PORT must be an integer between 1 and 65535/);
    }
    for (const PORT of [undefined, '', '1', '5000', '65535', ' 8080 ']) expect(validate({ PORT })).not.toThrow();
  });

  it('a set invite code must be at least 8 characters in EVERY mode', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(validate({ NODE_ENV, ANALYST_INVITE_CODE: 'short' })).toThrow(/ANALYST_INVITE_CODE must be at least 8/);
      expect(validate({ NODE_ENV, ANALYST_INVITE_CODE: '   abc   ' })).toThrow(/ANALYST_INVITE_CODE must be at least 8/);
      expect(validate({ NODE_ENV, ANALYST_INVITE_CODE: '12345678' })).not.toThrow();
      expect(validate({ NODE_ENV, ANALYST_INVITE_CODE: undefined })).not.toThrow();
      expect(validate({ NODE_ENV, ANALYST_INVITE_CODE: '' })).not.toThrow();
    }
  });
});

describe('E-15 the seed rejects an ADMIN_PASSWORD longer than 72 bytes', () => {
  const cfg = (ADMIN_PASSWORD) => ({
    NODE_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1:27017/finguardai_dev', ADMIN_EMAIL: 'a@b.com', ADMIN_PASSWORD,
  });
  it('72 bytes pass, 73 fail; multi-byte characters count as bytes', () => {
    expect(() => assertSeedConfig(cfg('a'.repeat(72)))).not.toThrow();
    expect(() => assertSeedConfig(cfg('a'.repeat(73)))).toThrow(/at most 72 bytes/);
    expect(() => assertSeedConfig(cfg('a'.repeat(72) + 'zzz'))).toThrow(/at most 72 bytes/);
    expect(() => assertSeedConfig(cfg('é'.repeat(36)))).not.toThrow(); // 36 characters = 72 bytes
    expect(() => assertSeedConfig(cfg('é'.repeat(37)))).toThrow(/at most 72 bytes/); // 37 characters = 74 bytes
  });
  it('is enforced for production configurations too, and the unset-NODE_ENV seed is strict (D-03)', () => {
    const prod = { ...cfg('a'.repeat(73)), NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://u:p@c.mongodb.net/db' };
    expect(() => assertSeedConfig(prod)).toThrow(/at most 72 bytes/);
    expect(() => assertSeedConfig({ ...cfg('shortpass1'), NODE_ENV: undefined })).toThrow(/at least 12 characters/);
    expect(() => assertSeedConfig({ ...cfg('shortpass1'), NODE_ENV: 'development' })).not.toThrow();
  });
});

describe('E-10 / H-05 parseDateBound', () => {
  const rejects = (text) => { try { parseDateBound(text, 'start', 'startDate'); return null; } catch (e) { return e; } };

  it('rejects out-of-range hour / minute / second and impossible calendar days with a status-400 error', () => {
    for (const text of [
      '2026-10-05T25:00', '2026-10-05T24:00', '2026-10-05T10:99', '2026-10-05T10:00:60', '2026-02-30T10:00', '2026-04-31T10:00', '2025-02-29T10:00',
      '2026-02-30T10:00:00Z', '2026-10-05T25:00:00Z', '2026-10-05T24:00:00.000Z', '2026-10-05T10:60:00Z',
      '2026-02-30T10:00:00+05:30', '2026-10-05T10:00:00+24:00', '2026-10-05T10:00:00+05:60', '2026-00-10T10:00', '2026-10-00T10:00',
    ]) {
      const error = rejects(text);
      expect([text, error?.status]).toEqual([text, 400]);
      expect(error.message).toMatch(/Invalid startDate/);
    }
  });

  it('still accepts valid values and keeps their meaning (zoneless = IST)', () => {
    expect(parseDateBound('2026-10-05T10:00', 'start').toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(parseDateBound('2026-10-05T23:59:59.999', 'end').toISOString()).toBe('2026-10-05T18:29:59.999Z');
    expect(parseDateBound('2026-10-05T10:00:00Z', 'start').toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(parseDateBound('2026-10-05T10:00:00+05:30', 'start').toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(parseDateBound('2026-10-05T10:00:00+0530', 'start').toISOString()).toBe('2026-10-05T04:30:00.000Z');
    expect(parseDateBound('2026-10-05T10:00:00.123456Z', 'start').toISOString()).toBe('2026-10-05T10:00:00.123Z');
    expect(parseDateBound('2024-02-29T10:00', 'start').toISOString()).toBe('2024-02-29T04:30:00.000Z'); // leap day
    expect(parseDateBound('2026-10-05', 'start').toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(parseDateBound('2026-10-05', 'end').toISOString()).toBe('2026-10-05T18:29:59.999Z');
    expect(rejects('2026-02-30')?.status).toBe(400);
    expect(rejects('May 5')?.status).toBe(400);
  });

  it('buildDateRange passes the 400 through', () => {
    expect(() => buildDateRange({ endDate: '2026-10-05T25:00' })).toThrow(/Invalid endDate/);
  });
});

describe('E-17 ensureIndexes', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  it('logs every failed model by name, still resolves, and reports the failures', async () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key error collection: x.fraudcases index: fraudAlertId_1'), { code: 11000 });
    const conflict = Object.assign(new Error('Index already exists with different options'), { code: 85 });
    const models = {
      Good: { init: async () => {} },
      FraudCase: { init: async () => { throw duplicate; } },
      FraudAlert: { init: async () => { throw conflict; } },
      Other: { init: async () => { throw new Error('boom'); } },
    };
    const failures = await ensureIndexes(models);
    expect(failures.map((f) => f.model)).toEqual(['FraudCase', 'FraudAlert', 'Other']);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    const logged = errorSpy.mock.calls.map((c) => c[0]);
    expect(logged[0]).toMatch(/model FraudCase: E11000 duplicate key[\s\S]*remove the duplicates/);
    expect(logged[1]).toMatch(/model FraudAlert: .*drop the old index/);
    expect(logged[2]).toMatch(/model Other: boom/);
  });

  it('is silent and returns [] when every index builds', async () => {
    expect(await ensureIndexes({ A: { init: async () => {} }, B: { init: async () => {} } })).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('defaults to every registered mongoose model (all have init)', async () => {
    const names = Object.keys(mongoose.models);
    expect(names).toEqual(expect.arrayContaining(['User', 'Transaction', 'FraudAlert', 'FraudCase', 'AuditLog', 'SystemConfig']));
    for (const model of Object.values(mongoose.models)) expect(typeof model.init).toBe('function');
  });

  describe('against a real database with duplicate data under a unique index', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);

    it('a unique index that cannot be built is logged with the model name and does not throw', async () => {
      const schema = new mongoose.Schema({ key: String }, { autoIndex: false });
      schema.index({ key: 1 }, { unique: true });
      const Probe = mongoose.models.R1IndexProbe ?? mongoose.model('R1IndexProbe', schema);
      await Probe.collection.insertMany([{ key: 'same' }, { key: 'same' }]);
      const failures = await ensureIndexes({ R1IndexProbe: { init: () => Probe.createIndexes() } });
      await Probe.collection.drop().catch(() => {});
      // Real MongoDB rejects the build; some emulators accept it. Either way the call must not throw.
      for (const failure of failures) expect(failure.model).toBe('R1IndexProbe');
      expect(errorSpy).toHaveBeenCalledTimes(failures.length);
    });
  });
});

describe('C-03 process error policy', () => {
  it('an unhandled rejection is logged and the server keeps running; an uncaught exception shuts down with code 1', () => {
    const proc = new EventEmitter();
    const shutdown = jest.fn();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    registerProcessErrorHandlers(proc, shutdown);

    proc.emit('unhandledRejection', new Error('forgotten promise'));
    expect(shutdown).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unhandled promise rejection'), expect.any(Error));

    const crash = new Error('bug');
    proc.emit('uncaughtException', crash);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('Uncaught exception', 1);
    errorSpy.mockRestore();
  });
});

describe('C-09 isTokenRevoked with sessionsRevokedAt', () => {
  const at = (ms) => new Date(ms);
  it('uses the later of passwordChangedAt and sessionsRevokedAt', () => {
    expect(isTokenRevoked({}, { iatMs: 1000 })).toBe(false);
    expect(isTokenRevoked({ sessionsRevokedAt: at(2000) }, { iatMs: 1500 })).toBe(true);
    expect(isTokenRevoked({ sessionsRevokedAt: at(2000) }, { iatMs: 2000 })).toBe(true);
    expect(isTokenRevoked({ sessionsRevokedAt: at(2000) }, { iatMs: 2001 })).toBe(false);
    expect(isTokenRevoked({ passwordChangedAt: at(3000), sessionsRevokedAt: at(2000) }, { iatMs: 2500 })).toBe(true);
    expect(isTokenRevoked({ passwordChangedAt: at(1000), sessionsRevokedAt: at(2000) }, { iatMs: 1500 })).toBe(true);
    expect(isTokenRevoked({ passwordChangedAt: at(1000), sessionsRevokedAt: null }, { iatMs: 1500 })).toBe(false);
    expect(isTokenRevoked({ sessionsRevokedAt: at(5000) }, { iat: 4 })).toBe(true);   // old tokens without iatMs
    expect(isTokenRevoked({ sessionsRevokedAt: at(5000) }, { iat: 6 })).toBe(false);
  });
});

describe('D-04 the user document never serialises secrets', () => {
  it('toJSON and toObject drop password, passwordChangedAt, sessionsRevokedAt and __v', () => {
    const user = new UserModel({ name: 'Zed Zed', email: 'zed@test.com', password: '$2b$12$hash', role: 'CUSTOMER', passwordChangedAt: new Date(), sessionsRevokedAt: new Date() });
    for (const out of [user.toJSON(), user.toObject(), JSON.parse(JSON.stringify(user))]) {
      expect(out).toMatchObject({ name: 'Zed Zed', email: 'zed@test.com', role: 'CUSTOMER' });
      for (const key of ['password', 'passwordChangedAt', 'sessionsRevokedAt', '__v']) expect(out).not.toHaveProperty(key);
    }
    expect(user.password).toBe('$2b$12$hash'); // the document itself is untouched
  });
});

describe('D-06 CORS options', () => {
  it('exposes the rate-limit headers', () => {
    expect(corsOptions.exposedHeaders).toEqual(expect.arrayContaining(['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']));
  });
});

describe('D-08 Cloudinary upload options', () => {
  it('restricts formats, limits the size, keeps names unique and returns a fresh object each time', () => {
    const options = getProfileUploadOptions();
    expect(options).toEqual({
      folder: 'finguardai/profiles',
      resource_type: 'image',
      allowed_formats: ['jpg', 'png', 'webp'],
      transformation: [{ width: 512, height: 512, crop: 'limit' }],
      unique_filename: true,
    });
    options.allowed_formats.push('gif');
    expect(getProfileUploadOptions().allowed_formats).toEqual(['jpg', 'png', 'webp']);
  });
});

describe('H-07 shared enums match the schemas', () => {
  it('model enums are built from the shared constants', () => {
    expect(TransactionModel.schema.path('riskLevel').enumValues).toEqual([...enums.RISK_LEVELS]);
    expect(TransactionModel.schema.path('paymentMethod').enumValues).toEqual([...enums.PAYMENT_METHODS]);
    expect(TransactionModel.schema.path('status').enumValues).toEqual([...enums.TRANSACTION_STATUSES]);
    expect(FraudAlertModel.schema.path('riskLevel').enumValues).toEqual([...enums.RISK_LEVELS]);
    expect(FraudAlertModel.schema.path('status').enumValues).toEqual([...enums.ALERT_STATUSES]);
    expect(FraudCaseModel.schema.path('status').enumValues).toEqual([...enums.CASE_STATUSES]);
    expect(UserModel.schema.path('role').enumValues).toEqual([...enums.ROLES]);
    expect(AuditLogModel.schema.path('actorRole').enumValues).toEqual([...enums.ROLES]);
  });
  it('the lists are frozen and the derived ones are consistent', () => {
    for (const list of Object.values(enums)) expect(Object.isFrozen(list)).toBe(true);
    expect(enums.FLAGGED_RISK_LEVELS).toEqual(['HIGH', 'CRITICAL']);
    expect(enums.ALERT_RISK_LEVELS).toEqual(['MEDIUM', 'HIGH', 'CRITICAL']);
    expect(enums.CASE_STATUSES).toEqual(['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED']);
  });
});
