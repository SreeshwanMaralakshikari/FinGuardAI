// tests/auth.test.js — CommonAPI (/auth) contract, Phase 4 + Phase 9 cookie options
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin } from './helpers/seedUser.js';
import { createAgent } from './helpers/authAgent.js';
import bcrypt from 'bcryptjs';
import UserModel from '../models/UserModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { setIO, hashToken, userRoom } from '../utils/socketManager.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const newUser = (o = {}) => ({ name: 'Alice', email: 'alice@test.com', password: 'Password@123', role: 'CUSTOMER', ...o });

describe('UserModel pre-save hook (Mongoose 9 — AUD-01)', () => {
  it('hashes the password on create and on password change', async () => {
    const { user } = await seedUser({ email: 'hash@test.com' });
    const created = await UserModel.findById(user._id).select('+password');
    expect(created.password).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    expect(await bcrypt.compare('Password@123', created.password)).toBe(true);

    created.password = 'Changed@123';
    await created.save();
    const changed = await UserModel.findById(user._id).select('+password');
    expect(changed.password).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare('Changed@123', changed.password)).toBe(true);
  });

  it('does not re-hash when another field changes', async () => {
    const { user } = await seedUser({ email: 'nohash@test.com' });
    const before = (await UserModel.findById(user._id).select('+password')).password;
    user.isActive = false;
    await user.save();
    const after = (await UserModel.findById(user._id).select('+password')).password;
    expect(after).toBe(before);
  });
});

describe('POST /auth/register', () => {
  it('creates a CUSTOMER and returns the flat user object (no cookie)', async () => {
    const res = await createAgent().post('/auth/register').send(newUser());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: 'alice@test.com', role: 'CUSTOMER' });
    expect(res.body.data).not.toHaveProperty('password');
    expect(res.headers['set-cookie']).toBeUndefined(); // registration does not log in (AUD-11)
  });

  it('creates an ANALYST when the invite code is right (L-11)', async () => {
    const res = await createAgent().post('/auth/register').send(newUser({ email: 'an@test.com', role: 'ANALYST', inviteCode: 'test-invite-code' }));
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('ANALYST');
  });

  it('rejects a duplicate email with 400', async () => {
    await seedUser({ email: 'dup@test.com' });
    const res = await createAgent().post('/auth/register').send(newUser({ email: 'dup@test.com' }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects role ADMIN with 422', async () => {
    const res = await createAgent().post('/auth/register').send(newUser({ email: 'x@test.com', role: 'ADMIN' }));
    expect(res.status).toBe(422);
  });

  it('requires role (422 when missing)', async () => {
    const { role, ...noRole } = newUser({ email: 'norole@test.com' });
    const res = await createAgent().post('/auth/register').send(noRole);
    expect(res.status).toBe(422);
  });

  it('validates required fields (422)', async () => {
    const res = await createAgent().post('/auth/register').send({ name: 'NoEmail' });
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});

describe('POST /auth/login', () => {
  it('logs in, returns the flat user and sets an HttpOnly cookie', async () => {
    const { user, password } = await seedUser({ email: 'login@test.com' });
    const res = await createAgent().post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'login@test.com', role: 'CUSTOMER' });
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/token=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/); // non-production (Phase 9 cookieOptions)
  });

  it('returns 401 for a wrong password and for an unknown email', async () => {
    const { user } = await seedUser({ email: 'wp@test.com' });
    expect((await createAgent().post('/auth/login').send({ email: user.email, password: 'Wrong@999' })).status).toBe(401);
    expect((await createAgent().post('/auth/login').send({ email: 'nobody@test.com', password: 'Password@123' })).status).toBe(401);
  });

  it('returns 403 for a deactivated account', async () => {
    const { user, password } = await seedUser({ email: 'inactive@test.com', isActive: false });
    expect((await createAgent().post('/auth/login').send({ email: user.email, password })).status).toBe(403);
  });

  it('rate-limits a single client to 10 auth requests per 15 minutes', async () => {
    const agent = createAgent('203.0.113.200');
    for (let i = 0; i < 10; i += 1) {
      await agent.post('/auth/login').send({ email: 'nobody@test.com', password: 'Password@123' });
    }
    const res = await agent.post('/auth/login').send({ email: 'nobody@test.com', password: 'Password@123' });
    expect(res.status).toBe(429);
  });
});

describe('Round-2 audit fixes (auth)', () => {
  it('AUD-23: changing the password ends the account\'s OTHER sessions too', async () => {
    const { user, password } = await seedUser({ email: 'multi@test.com' });
    const laptop = createAgent();
    const phone = createAgent();
    await laptop.post('/auth/login').send({ email: user.email, password });
    await phone.post('/auth/login').send({ email: user.email, password });
    // No sleep needed (L-15): the change time is exact and tokens carry a millisecond issue time.
    expect((await laptop.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'NewPass@456' })).status).toBe(200);
    expect((await phone.get('/auth/check-auth')).status).toBe(401);
    const again = createAgent();
    expect((await again.post('/auth/login').send({ email: user.email, password: 'NewPass@456' })).status).toBe(200);
    expect((await again.get('/auth/check-auth')).status).toBe(200); // a new login right away still works
  });

  it('AUD-24: dots and +tags in Gmail addresses are preserved', async () => {
    const reg = await createAgent().post('/auth/register').send({ name: 'First Last', email: 'First.Last+fg@Gmail.com', password: 'Password@123', role: 'CUSTOMER' });
    expect(reg.body.data.email).toBe('first.last+fg@gmail.com');
    await seedUser({ email: 'seeded.admin@gmail.com', role: 'ADMIN' }); // as seedAdmin.js stores it
    expect((await createAgent().post('/auth/login').send({ email: 'seeded.admin@gmail.com', password: 'Password@123' })).status).toBe(200);
  });

  it('AUD-25: non-string credentials → 422, not 500', async () => {
    expect((await createAgent().post('/auth/login').send({ email: 'x@test.com', password: { a: 1 } })).status).toBe(422);
    expect((await createAgent().post('/auth/login').send({ email: 'x@test.com', password: ['Password@123'] })).status).toBe(422);
  });

  it('AUD-28: successful logins do not count toward the limit (shared Wi-Fi)', async () => {
    const { user, password } = await seedUser({ email: 'many@test.com' });
    const sameIp = '203.0.113.201';
    for (let i = 0; i < 12; i += 1) {
      expect((await createAgent(sameIp).post('/auth/login').send({ email: user.email, password })).status).toBe(200);
    }
  });

  it('AUD-28: a deactivated account with a WRONG password gets 401 (no account enumeration)', async () => {
    const { user } = await seedUser({ email: 'enum@test.com', isActive: false });
    expect((await createAgent().post('/auth/login').send({ email: user.email, password: 'Wrong@999' })).status).toBe(401);
  });
});

describe('Session: check-auth, logout, change-password', () => {
  it('check-auth returns the user when logged in and 401 otherwise', async () => {
    const { user, password } = await seedUser({ email: 'chk@test.com' });
    const agent = createAgent();
    await agent.post('/auth/login').send({ email: user.email, password });
    const res = await agent.get('/auth/check-auth');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'chk@test.com', isActive: true });
    expect((await createAgent().get('/auth/check-auth')).status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const { user, password } = await seedUser({ email: 'logout@test.com' });
    const agent = createAgent();
    await agent.post('/auth/login').send({ email: user.email, password });
    expect((await agent.post('/auth/logout')).status).toBe(200);
    expect((await agent.get('/auth/check-auth')).status).toBe(401);
  });

  it('PATCH /auth/change-password updates the password and ends the session', async () => {
    const { user, password } = await seedUser({ email: 'cp@test.com' });
    const agent = createAgent();
    const login = await agent.post('/auth/login').send({ email: user.email, password });
    const oldCookie = login.headers['set-cookie'];
    const res = await agent.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'NewPass@456' });
    expect(res.status).toBe(200);
    expect((await agent.get('/auth/check-auth')).status).toBe(401); // the agent dropped its cookie…
    // …so ALSO replay the old cookie by hand: the server itself must reject the revoked token.
    const replay = await createAgent().get('/auth/check-auth').set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
    expect((await createAgent().post('/auth/login').send({ email: user.email, password: 'NewPass@456' })).status).toBe(200);
  });

  it('change-password rejects a wrong current password with 400', async () => {
    const { user, password } = await seedUser({ email: 'cpw@test.com' });
    const agent = createAgent();
    await agent.post('/auth/login').send({ email: user.email, password });
    const res = await agent.patch('/auth/change-password').send({ currentPassword: 'Wrong@000', newPassword: 'NewPass@456' });
    expect(res.status).toBe(400);
  });

  it('ADMIN seeded through the model can log in', async () => {
    const { user, password } = await seedAdmin({ email: 'admin@test.com' });
    const res = await createAgent().post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
  });
});

// ── Fix round: L-11, L-09, L-12, L-06, L-15, N-26 ─────────────────────────────

const tokenFromCookies = (setCookie) => /token=([^;]+)/.exec(setCookie.join(';'))[1];

describe('L-11 ANALYST registration needs an invite code', () => {
  const savedCode = process.env.ANALYST_INVITE_CODE;
  afterEach(() => { process.env.ANALYST_INVITE_CODE = savedCode; });
  const registerAnalyst = (extra = {}) =>
    createAgent().post('/auth/register').send(newUser({ email: `an${Math.random()}@test.com`, role: 'ANALYST', ...extra }));

  it('403 "disabled" when ANALYST_INVITE_CODE is not configured (even with a code)', async () => {
    delete process.env.ANALYST_INVITE_CODE;
    for (const extra of [{}, { inviteCode: 'anything' }]) {
      const res = await registerAnalyst(extra);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'Analyst registration is disabled.' });
    }
    process.env.ANALYST_INVITE_CODE = '   '; // blank counts as unset
    expect((await registerAnalyst({ inviteCode: '   ' })).status).toBe(403);
  });

  it('403 "Invalid invite code." for a missing or wrong code; nothing is created', async () => {
    for (const extra of [{}, { inviteCode: '' }, { inviteCode: 'wrong-code' }, { inviteCode: 'test-invite-code-and-more' }]) {
      const res = await registerAnalyst(extra);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'Invalid invite code.' });
    }
    expect(await UserModel.countDocuments({ role: 'ANALYST' })).toBe(0);
  });

  it('the wrong code is rejected before the duplicate-email check (no account probing)', async () => {
    await seedUser({ email: 'taken@test.com' });
    const res = await registerAnalyst({ email: 'taken@test.com', inviteCode: 'nope' });
    expect(res.status).toBe(403);
  });

  it('201 with the right code; a non-string code is a 422', async () => {
    expect((await registerAnalyst({ inviteCode: 'test-invite-code' })).status).toBe(201);
    expect((await registerAnalyst({ inviteCode: 12345 })).status).toBe(422);
  });

  it('CUSTOMER registration ignores inviteCode, right or wrong', async () => {
    expect((await createAgent().post('/auth/register').send(newUser({ email: 'c1@test.com', inviteCode: 'wrong' }))).status).toBe(201);
    delete process.env.ANALYST_INVITE_CODE;
    expect((await createAgent().post('/auth/register').send(newUser({ email: 'c2@test.com', inviteCode: 'anything' }))).status).toBe(201);
  });
});

describe('N-26 / L-15 register validation', () => {
  it('422 bodies carry message (first error) AND the errors[] list', async () => {
    const res = await createAgent().post('/auth/register').send({ name: 'X', email: 'bad', password: 'short', role: 'CUSTOMER' });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(res.body.errors[0].msg);
    expect(res.body.errors.length).toBeGreaterThan(1);
    expect(res.body.errors[0]).toHaveProperty('path');
  });

  it('role as an array/object/number → 422 (used to reach Mongoose and fail with a cast message)', async () => {
    for (const role of [['ANALYST'], ['CUSTOMER'], { a: 1 }, 5]) {
      const res = await createAgent().post('/auth/register').send(newUser({ email: 'r@test.com', role }));
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/Role must be CUSTOMER or ANALYST/);
    }
  });

  it('passwords are limited to 72 BYTES (bcrypt truncates silently beyond that)', async () => {
    const agent = createAgent();
    expect((await agent.post('/auth/register').send(newUser({ email: 'p72@test.com', password: 'a'.repeat(72) }))).status).toBe(201);
    const tooLong = await agent.post('/auth/register').send(newUser({ email: 'p73@test.com', password: 'a'.repeat(73) }));
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.message).toMatch(/Password must be at most 72/);
    // the report's case: a 100,000-character password used to register (only its first 72 bytes counted)
    expect((await agent.post('/auth/register').send(newUser({ email: 'p100k@test.com', password: 'a'.repeat(100000) }))).status).toBe(422);
    // 25 × "é" = 50 chars-worth of 2-byte code points = 50 bytes → fine; 40 × "é" = 80 bytes → rejected
    expect((await agent.post('/auth/register').send(newUser({ email: 'pe25@test.com', password: 'é'.repeat(25) }))).status).toBe(201);
    expect((await agent.post('/auth/register').send(newUser({ email: 'pe40@test.com', password: 'é'.repeat(40) }))).status).toBe(422);
  });

  it('change-password also rejects a new password longer than 72 bytes', async () => {
    const { user, password } = await seedUser({ email: 'cplong@test.com' });
    const agent = createAgent();
    await agent.post('/auth/login').send({ email: user.email, password });
    const res = await agent.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'b'.repeat(73) });
    expect(res.status).toBe(422);
    expect((await agent.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'b'.repeat(72) })).status).toBe(200);
  });

  it('application/x-www-form-urlencoded is no longer parsed (the API is JSON + multipart only)', async () => {
    const res = await createAgent().post('/auth/login').type('form').send({ email: 'a@test.com', password: 'Password@123' });
    expect(res.status).toBe(422); // body ignored → required fields missing
  });
});

describe('L-12 rate limiters', () => {
  it('register counts EVERY request (20 / hour / IP), successful ones too', async () => {
    const agent = createAgent('203.0.113.50');
    expect((await agent.post('/auth/register').send(newUser({ email: 'rl1@test.com' }))).status).toBe(201);
    expect((await agent.post('/auth/register').send(newUser({ email: 'rl2@test.com' }))).status).toBe(201);
    for (let i = 0; i < 18; i += 1) await agent.post('/auth/register').send({ name: 'x' }); // 422s count as well
    const blocked = await agent.post('/auth/register').send(newUser({ email: 'rl3@test.com' }));
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.message).toMatch(/Too many registration attempts/);
  });

  it('failed logins no longer lock registration from the same IP (separate limiter stores)', async () => {
    const ip = '203.0.113.51';
    for (let i = 0; i < 10; i += 1) await createAgent(ip).post('/auth/login').send({ email: 'nobody@test.com', password: 'Password@123' });
    expect((await createAgent(ip).post('/auth/login').send({ email: 'nobody@test.com', password: 'Password@123' })).status).toBe(429);
    expect((await createAgent(ip).post('/auth/register').send(newUser({ email: 'still-ok@test.com' }))).status).toBe(201);
  });

  it('change-password: 5 FAILED attempts per user per 15 min, then 429 — even with the right password', async () => {
    const ip = '203.0.113.52';
    const { user, password } = await seedUser({ email: 'cplimit@test.com' });
    const { user: other, password: otherPassword } = await seedUser({ email: 'cplimit2@test.com' });
    const victim = createAgent(ip); const bystander = createAgent(ip);
    await victim.post('/auth/login').send({ email: user.email, password });
    await bystander.post('/auth/login').send({ email: other.email, password: otherPassword });
    for (let i = 0; i < 5; i += 1) {
      expect((await victim.patch('/auth/change-password').send({ currentPassword: 'Wrong@000', newPassword: 'NewPass@456' })).status).toBe(400);
    }
    const blocked = await victim.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'NewPass@456' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/Too many failed attempts/);
    // keyed by user id, not by IP: a different user behind the same IP is unaffected
    expect((await bystander.patch('/auth/change-password').send({ currentPassword: otherPassword, newPassword: 'NewPass@456' })).status).toBe(200);
  });

  it('successful password changes do not use up the budget', async () => {
    const { user, password } = await seedUser({ email: 'cpok@test.com' });
    let current = password;
    for (let i = 0; i < 7; i += 1) {
      const agent = createAgent('203.0.113.53');
      await agent.post('/auth/login').send({ email: user.email, password: current });
      const next = `NewPass@${i}00`;
      expect((await agent.patch('/auth/change-password').send({ currentPassword: current, newPassword: next })).status).toBe(200);
      current = next;
    }
  });
});

describe('L-09 / BS-19 login', () => {
  it('an unknown e-mail still performs one bcrypt comparison (same cost, same 401 message)', async () => {
    const spy = jest.spyOn(bcrypt, 'compare');
    try {
      const unknown = await createAgent().post('/auth/login').send({ email: 'ghost@test.com', password: 'Password@123' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.message).toBe('Invalid email or password.');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatch(/^\$2[aby]\$12\$/); // a cost-12 hash, like real users
      const { user } = await seedUser({ email: 'real@test.com' });
      spy.mockClear();
      const wrong = await createAgent().post('/auth/login').send({ email: user.email, password: 'Wrong@000' });
      expect(wrong.body.message).toBe(unknown.body.message);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('failed logins of a real account are audited — without the password; unknown e-mails have no actor to log', async () => {
    const { user } = await seedUser({ email: 'audited@test.com' });
    await createAgent().post('/auth/login').send({ email: user.email, password: 'Wrong@000-secret' });
    await createAgent().post('/auth/login').send({ email: 'ghost@test.com', password: 'Password@123' });
    const entries = await AuditLogModel.find({ action: 'LOGIN_FAILED' });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].actorId)).toBe(String(user._id));
    expect(entries[0].metadata).toEqual({ email: 'audited@test.com', reason: 'WRONG_PASSWORD' });
    expect(JSON.stringify(entries[0])).not.toMatch(/Wrong@000-secret/);
  });

  it('a correct password on a deactivated account is audited as ACCOUNT_DEACTIVATED', async () => {
    const { user, password } = await seedUser({ email: 'off@test.com', isActive: false });
    expect((await createAgent().post('/auth/login').send({ email: user.email, password })).status).toBe(403);
    const entry = await AuditLogModel.findOne({ action: 'LOGIN_FAILED' });
    expect(entry.metadata.reason).toBe('ACCOUNT_DEACTIVATED');
  });
});

describe('L-15 dead sessions clear the cookie (logout, check-auth)', () => {
  const cleared = (res) => (res.headers['set-cookie'] ?? []).some((c) => /^token=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));

  it('a deactivated user: 403 and the cookie is removed (check-auth and logout)', async () => {
    const { user, password } = await seedUser({ email: 'deact@test.com' });
    const login = await createAgent().post('/auth/login').send({ email: user.email, password });
    const cookie = `token=${tokenFromCookies(login.headers['set-cookie'])}`;
    await UserModel.updateOne({ _id: user._id }, { isActive: false });
    const check = await createAgent().get('/auth/check-auth').set('Cookie', cookie);
    expect(check.status).toBe(403);
    expect(cleared(check)).toBe(true);
    const logout = await createAgent().post('/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(403);
    expect(cleared(logout)).toBe(true);
  });

  it('an invalid or expired token: 401 and the cookie is removed; no cookie at all: 401, nothing to remove', async () => {
    const garbage = await createAgent().get('/auth/check-auth').set('Cookie', 'token=not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(cleared(garbage)).toBe(true);
    const expired = await createAgent().post('/auth/logout').set('Cookie', 'token=' + (await import('jsonwebtoken')).default.sign({ id: 'x' }, process.env.JWT_SECRET, { expiresIn: -10 }));
    expect(expired.status).toBe(401);
    expect(cleared(expired)).toBe(true);
    const none = await createAgent().get('/auth/check-auth');
    expect(none.status).toBe(401);
    expect(none.headers['set-cookie']).toBeUndefined();
  });

  it('other routes do NOT clear the cookie on 401 (a parallel login may have just replaced it)', async () => {
    const res = await createAgent().get('/customer-api/profile').set('Cookie', 'token=not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('L-06 sessions end → live sockets close', () => {
  const makeSocket = (userId, token) => ({ data: { tokenHash: hashToken(token) }, rooms: new Set([userRoom(userId)]), disconnect: jest.fn() });
  const installIO = (sockets) => setIO({
    in: (room) => ({ fetchSockets: async () => sockets.filter((s) => s.rooms.has(room)) }),
    to: () => ({ emit: () => {} }),
    emit: () => {},
  });
  afterEach(() => installIO([]));

  it('logout disconnects the sockets of THIS session only', async () => {
    const { user, password } = await seedUser({ email: 'sock1@test.com' });
    const laptop = createAgent(); const phone = createAgent();
    const laptopLogin = await laptop.post('/auth/login').send({ email: user.email, password });
    const phoneLogin = await phone.post('/auth/login').send({ email: user.email, password });
    const laptopSocket = makeSocket(user._id, tokenFromCookies(laptopLogin.headers['set-cookie']));
    const phoneSocket = makeSocket(user._id, tokenFromCookies(phoneLogin.headers['set-cookie']));
    installIO([laptopSocket, phoneSocket]);
    expect((await laptop.post('/auth/logout')).status).toBe(200);
    expect(laptopSocket.disconnect).toHaveBeenCalledWith(true);
    expect(phoneSocket.disconnect).not.toHaveBeenCalled();
  });

  it('a password change disconnects every socket of the user', async () => {
    const { user, password } = await seedUser({ email: 'sock2@test.com' });
    const a = createAgent(); const b = createAgent();
    const la = await a.post('/auth/login').send({ email: user.email, password });
    const lb = await b.post('/auth/login').send({ email: user.email, password });
    const sockA = makeSocket(user._id, tokenFromCookies(la.headers['set-cookie']));
    const sockB = makeSocket(user._id, tokenFromCookies(lb.headers['set-cookie']));
    installIO([sockA, sockB]);
    expect((await a.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'NewPass@456' })).status).toBe(200);
    expect(sockA.disconnect).toHaveBeenCalledWith(true);
    expect(sockB.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('Tokens', () => {
  it('login issues a JWT with a millisecond issue time (iatMs) next to the standard iat', async () => {
    const { user, password } = await seedUser({ email: 'claims@test.com' });
    const before = Date.now();
    const res = await createAgent().post('/auth/login').send({ email: user.email, password });
    const claims = (await import('jsonwebtoken')).default.decode(tokenFromCookies(res.headers['set-cookie']));
    expect(claims.iatMs).toBeGreaterThanOrEqual(before);
    expect(claims.iatMs).toBeLessThanOrEqual(Date.now());
    expect(Math.floor(claims.iatMs / 1000)).toBe(claims.iat);
  });

  it('passwordChangedAt is the exact time of the change (not back-dated)', async () => {
    const { user, password } = await seedUser({ email: 'exact@test.com' });
    const agent = createAgent();
    await agent.post('/auth/login').send({ email: user.email, password });
    const before = Date.now();
    await agent.patch('/auth/change-password').send({ currentPassword: password, newPassword: 'NewPass@456' });
    const { passwordChangedAt } = await UserModel.findById(user._id).select('+passwordChangedAt');
    expect(passwordChangedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(passwordChangedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
