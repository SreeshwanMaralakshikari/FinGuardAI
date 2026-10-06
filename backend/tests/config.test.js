// tests/config.test.js — startup safety: validateEnv, seedAdmin checks, the test-database guard,
// and the socket session helpers.
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import mongoose from 'mongoose';
import validateEnv from '../config/validateEnv.js';
import { getMongoDbName, isLocalMongoUri } from '../config/mongoUri.js';
import { assertSafeTestDatabase, connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { assertSeedConfig, seed } from '../seed/seedAdmin.js';
import { socketAuthMiddleware } from '../utils/socketAuth.js';
import { setIO, disconnectUser, hashToken, userRoom } from '../utils/socketManager.js';
import { seedUser } from './helpers/seedUser.js';
import UserModel from '../models/UserModel.js';
import jwt from 'jsonwebtoken';

const ENV_KEYS = [
  'NODE_ENV', 'RENDER', 'MONGODB_URI', 'JWT_SECRET', 'FRONTEND_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET', 'APP_TIME_ZONE', 'COOKIE_MODE', 'COOKIE_DOMAIN', 'ANALYST_INVITE_CODE',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } };

const goodProduction = () => ({
  NODE_ENV: 'production',
  RENDER: undefined,
  MONGODB_URI: 'mongodb+srv://u:p@cluster0.mongodb.net/finguardai?retryWrites=true&w=majority',
  JWT_SECRET: 'a'.repeat(64),
  FRONTEND_URL: 'https://finguardai.vercel.app',
  CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
  APP_TIME_ZONE: undefined, COOKIE_MODE: undefined, COOKIE_DOMAIN: undefined,
  ANALYST_INVITE_CODE: 'a-long-enough-invite',
});
const setEnv = (env) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const validate = (overrides = {}) => { setEnv({ ...goodProduction(), ...overrides }); return () => validateEnv(); };

describe('validateEnv', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); restoreEnv(); });

  it('accepts a complete production configuration without warnings', () => {
    expect(validate()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('D-04: production fails when MONGODB_URI has no database name; development only warns', () => {
    const noDb = 'mongodb+srv://u:p@cluster0.mongodb.net/?retryWrites=true';
    expect(validate({ MONGODB_URI: noDb })).toThrow(/no database name/);
    expect(validate({ MONGODB_URI: 'mongodb+srv://u:p@cluster0.mongodb.net' })).toThrow(/no database name/);
    expect(validate({ NODE_ENV: 'development', MONGODB_URI: noDb })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no database name/));
  });

  it('D-05: RENDER without NODE_ENV=production is fatal', () => {
    expect(validate({ RENDER: 'true', NODE_ENV: 'development' })).toThrow(/NODE_ENV must be "production" on Render/);
    expect(validate({ RENDER: 'true', NODE_ENV: undefined })).toThrow(/NODE_ENV must be "production" on Render/);
    expect(validate({ RENDER: 'true', NODE_ENV: 'production' })).not.toThrow();
    expect(validate({ RENDER: undefined, NODE_ENV: 'development' })).not.toThrow();
  });

  it('D-10: production rejects placeholder and short JWT secrets', () => {
    expect(validate({ JWT_SECRET: 'replace-with-a-long-random-string' })).toThrow(/placeholder/);
    expect(validate({ JWT_SECRET: 'xx-replace-with-' + 'z'.repeat(40) })).toThrow(/placeholder/);
    expect(validate({ JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(validate({ NODE_ENV: 'development', JWT_SECRET: 'replace-with-a-long-random-string' })).not.toThrow();
  });

  it('N-11: an invalid APP_TIME_ZONE fails with a clear message', () => {
    expect(validate({ APP_TIME_ZONE: 'Mars/Olympus' })).toThrow(/APP_TIME_ZONE "Mars\/Olympus" is not a valid IANA time zone/);
    expect(validate({ APP_TIME_ZONE: 'Asia/Kolkata' })).not.toThrow();
  });

  it('D-02: COOKIE_MODE must be cross-site or same-site; COOKIE_DOMAIN must look like a domain', () => {
    expect(validate({ COOKIE_MODE: 'strict' })).toThrow(/COOKIE_MODE must be one of: cross-site, same-site/);
    expect(validate({ COOKIE_MODE: 'same-site', COOKIE_DOMAIN: '.example.com' })).not.toThrow();
    expect(validate({ COOKIE_MODE: 'cross-site' })).not.toThrow();
    expect(validate({ COOKIE_MODE: 'same-site', COOKIE_DOMAIN: 'bad domain;' })).toThrow(/COOKIE_DOMAIN/);
    expect(validate({ COOKIE_MODE: 'cross-site', COOKIE_DOMAIN: '.example.com' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/COOKIE_DOMAIN is ignored/));
  });

  it('L-11: ANALYST_INVITE_CODE unset → warning only; set but shorter than 8 characters → fatal in production', () => {
    expect(validate({ ANALYST_INVITE_CODE: undefined })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/analyst registration is disabled/i));
    expect(validate({ ANALYST_INVITE_CODE: 'short' })).toThrow(/ANALYST_INVITE_CODE must be at least 8/);
    expect(validate({ ANALYST_INVITE_CODE: '12345678' })).not.toThrow();
  });
});

describe('Mongo URI helpers', () => {
  it('extract the database name and detect local hosts', () => {
    expect(getMongoDbName('mongodb+srv://u:p%40ss@c.mongodb.net/finguardai?retryWrites=true')).toBe('finguardai');
    expect(getMongoDbName('mongodb+srv://u:p@c.mongodb.net/?retryWrites=true')).toBe('');
    expect(getMongoDbName('mongodb://127.0.0.1:27017/finguardai_test')).toBe('finguardai_test');
    expect(getMongoDbName(undefined)).toBe('');
    expect(isLocalMongoUri('mongodb://127.0.0.1:27017/x')).toBe(true);
    expect(isLocalMongoUri('mongodb://localhost/x')).toBe(true);
    expect(isLocalMongoUri('mongodb+srv://u:p@c.mongodb.net/x')).toBe(false);
  });
});

describe('D-09 test database guard', () => {
  it('refuses names without "test" and the production database', () => {
    expect(() => assertSafeTestDatabase('finguardai')).toThrow(/does not contain "test"/);
    expect(() => assertSafeTestDatabase('')).toThrow(/does not contain "test"/);
    expect(() => assertSafeTestDatabase(undefined)).toThrow(/does not contain "test"/);
    expect(() => assertSafeTestDatabase('finguardai_test')).not.toThrow();
    expect(() => assertSafeTestDatabase('MyTestDb')).not.toThrow();
    expect(() => assertSafeTestDatabase('finguardai_test', 'finguardai_test')).toThrow(/database named in MONGODB_URI/);
  });
});

describe('D-04 / D-10 seedAdmin configuration checks', () => {
  const local = 'mongodb://127.0.0.1:27017/finguardai_dev';
  const remote = 'mongodb+srv://u:p@cluster0.mongodb.net/finguardai?retryWrites=true';
  const cfg = (o = {}) => ({ NODE_ENV: 'development', MONGODB_URI: local, ADMIN_EMAIL: 'a@b.com', ADMIN_PASSWORD: 'short-pass-1', ...o });

  it('requires the basics and an 8+ character password', () => {
    expect(() => assertSeedConfig(cfg({ MONGODB_URI: '' }))).toThrow(/MONGODB_URI is not set/);
    expect(() => assertSeedConfig(cfg({ ADMIN_EMAIL: '' }))).toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD/);
    expect(() => assertSeedConfig(cfg({ ADMIN_PASSWORD: '1234567' }))).toThrow(/at least 8/);
  });

  it('D-04: no database name → fatal against a remote/production database, warning against localhost', () => {
    expect(() => assertSeedConfig(cfg({ MONGODB_URI: 'mongodb+srv://u:p@c.mongodb.net/?x=1', ADMIN_PASSWORD: 'a-very-strong-password' }))).toThrow(/no database name/);
    expect(assertSeedConfig(cfg({ MONGODB_URI: 'mongodb://127.0.0.1:27017' })).warnings[0]).toMatch(/no database name/);
  });

  it('D-10: placeholder or short passwords are refused for production / remote databases only', () => {
    expect(() => assertSeedConfig(cfg({ MONGODB_URI: remote, ADMIN_PASSWORD: 'change-me-strong-password' }))).toThrow(/placeholder/);
    expect(() => assertSeedConfig(cfg({ NODE_ENV: 'production', ADMIN_PASSWORD: 'change-me-strong-password' }))).toThrow(/placeholder/);
    expect(() => assertSeedConfig(cfg({ MONGODB_URI: remote, ADMIN_PASSWORD: 'only-11-chr' }))).toThrow(/at least 12/);
    expect(() => assertSeedConfig(cfg({ MONGODB_URI: remote, ADMIN_PASSWORD: 'a-very-strong-password' }))).not.toThrow();
    expect(() => assertSeedConfig(cfg({ ADMIN_PASSWORD: 'change-me-strong-password' }))).not.toThrow(); // local dev convenience
  });
});

describe('D-10 seed(): an existing non-ADMIN account is a failure, not a success', () => {
  let savedUri;
  beforeAll(connectTestDB);
  afterAll(disconnectTestDB);
  beforeEach(async () => {
    await clearCollections();
    savedUri = { MONGODB_URI: process.env.MONGODB_URI, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  });
  afterEach(() => { restoreEnv(); for (const [k, v] of Object.entries(savedUri)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const runSeed = () => {
    // Same URI the test connection uses; MONGODB_URI is only set while seed() runs
    // (tests/setup.js refuses to wipe a database named in MONGODB_URI).
    process.env.MONGODB_URI = process.env.MONGO_URI_TEST ?? 'mongodb://127.0.0.1:27017/seed_test';
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_EMAIL = 'Seed.Admin@Test.com';
    process.env.ADMIN_PASSWORD = 'Seed-Admin-Pass-1';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const done = () => log.mockRestore();
    return seed().finally(() => { delete process.env.MONGODB_URI; done(); });
  };

  it('creates the ADMIN once and is idempotent', async () => {
    await runSeed();
    const admin = await UserModel.findOne({ email: 'seed.admin@test.com' });
    expect(admin.role).toBe('ADMIN');
    await runSeed(); // second run: "already exists", no error
    expect(await UserModel.countDocuments({ email: 'seed.admin@test.com' })).toBe(1);
  });

  it('rejects (→ exit code 1 in the script) when the e-mail was registered first with another role', async () => {
    await seedUser({ email: 'seed.admin@test.com', role: 'CUSTOMER' });
    await expect(runSeed()).rejects.toThrow(/already exists with role CUSTOMER, not ADMIN/);
    expect((await UserModel.findOne({ email: 'seed.admin@test.com' })).role).toBe('CUSTOMER');
  });
});

describe('L-06 socket sessions', () => {
  const makeSocket = (userId, token) => ({
    data: { tokenHash: hashToken(token) },
    rooms: new Set([userRoom(userId)]),
    disconnect: jest.fn(),
  });
  const makeIO = (sockets) => ({
    in: (room) => ({ fetchSockets: async () => sockets.filter((s) => s.rooms.has(room)) }),
    to: () => ({ emit: () => {} }),
    emit: () => {},
  });

  it('disconnectUser closes every socket of the user, or only the ones using a given token', async () => {
    const a1 = makeSocket('u1', 'tokA'); const a2 = makeSocket('u1', 'tokB'); const b1 = makeSocket('u2', 'tokA');
    setIO(makeIO([a1, a2, b1]));
    expect(await disconnectUser('u1', { token: 'tokA' })).toBe(1);
    expect(a1.disconnect).toHaveBeenCalledWith(true);
    expect(a2.disconnect).not.toHaveBeenCalled();
    expect(await disconnectUser('u1')).toBe(2);
    expect(a2.disconnect).toHaveBeenCalledWith(true);
    expect(b1.disconnect).not.toHaveBeenCalled(); // another user is never touched
    setIO(makeIO([]));
  });

  it('disconnectUser is a harmless no-op / swallows errors', async () => {
    setIO({ in: () => ({ fetchSockets: async () => { throw new Error('adapter down'); } }), to: () => ({ emit() {} }), emit() {} });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await disconnectUser('u1')).toBe(0);
    err.mockRestore();
    setIO(makeIO([]));
  });

  describe('handshake (socketAuthMiddleware)', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);
    beforeEach(clearCollections);

    const handshake = async (token) => {
      const socket = { handshake: { headers: { cookie: token ? `token=${token}` : '' } }, data: {} };
      const error = await new Promise((resolve) => socketAuthMiddleware(socket, resolve));
      return { socket, error };
    };
    const sign = (userId, extra = {}) => jwt.sign({ id: String(userId), iatMs: Date.now(), ...extra }, process.env.JWT_SECRET, { expiresIn: '6h' });

    it('accepts a valid token and remembers its fingerprint', async () => {
      const { user } = await seedUser();
      const token = sign(user._id);
      const { socket, error } = await handshake(token);
      expect(error).toBeUndefined();
      expect(socket.data.user).toEqual({ id: String(user._id), role: 'CUSTOMER' });
      expect(socket.data.tokenHash).toBe(hashToken(token));
    });

    it('rejects a missing token, a forged token, an unknown user and a deactivated user', async () => {
      const { user } = await seedUser({ isActive: false });
      expect((await handshake('')).error.message).toBe('UNAUTHENTICATED');
      expect((await handshake(jwt.sign({ id: String(user._id) }, 'wrong-secret'))).error.message).toBe('UNAUTHENTICATED');
      expect((await handshake(sign(new mongoose.Types.ObjectId()))).error.message).toBe('UNAUTHENTICATED');
      expect((await handshake(sign(user._id))).error.message).toBe('UNAUTHENTICATED');
    });

    it('rejects a token issued before the last password change, accepts one issued after', async () => {
      const { user } = await seedUser();
      const before = sign(user._id);
      const doc = await UserModel.findById(user._id).select('+password');
      doc.password = 'Another@Pass1';
      await doc.save();
      expect((await handshake(before)).error.message).toBe('UNAUTHENTICATED');
      expect((await handshake(sign(user._id))).error).toBeUndefined();
    });
  });
});
