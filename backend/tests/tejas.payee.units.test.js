// tests/tejas.payee.units.test.js — TEJAS D1 (step 1): payee helpers and validators. No database needed.
import { describe, expect, it } from '@jest/globals';
import { validationResult } from 'express-validator';
import {
  VPA_PATTERN, normalizeVpa, isValidVpa, normalizeMerchantName, buildPayee, isPayeeKey, payeeLabel, PAYEE_KEY_PREFIX,
} from '../utils/payee.js';
import { submitTransactionRules } from '../validators/transactionValidators.js';
import { addWatchlistRules, payeeProfileRules, listWatchlistRules, removeWatchlistRules } from '../validators/payeeValidators.js';
import { customerPayeeView, plainPayee, plainPayeeSignals } from '../services/payeeService.js';

/** Run express-validator chains against a fake request; returns { errors, req }. */
const run = async (rules, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
  const req = { body, query, params, headers };
  for (const rule of rules) await rule.run(req);
  return { errors: validationResult(req).array(), req };
};

const goodPayment = (extra = {}) => ({
  amount: 500, merchantName: 'BookStore', paymentMethod: 'UPI', location: { city: 'Mumbai' }, deviceId: 'dev-1', ...extra,
});

describe('UPI ID helpers', () => {
  it('normalises case, width and surrounding spaces; non-strings become empty', () => {
    expect(normalizeVpa('  Ravi.K@OkAxis ')).toBe('ravi.k@okaxis');
    expect(normalizeVpa('ｒａｖｉ@ybl')).toBe('ravi@ybl'); // full-width letters (NFKC)
    expect(normalizeVpa(undefined)).toBe('');
    expect(normalizeVpa(42)).toBe('');
    expect(normalizeVpa({ $ne: '' })).toBe('');
  });

  it.each([
    ['ravi@okaxis', true], ['ravi.kumar-99_x@ybl', true], ['9876543210@paytm', true], ['ab@upi', true],
    ['a@upi', false],              // handle too short
    ['.ravi@ybl', false],          // must start with a letter or digit
    ['ravi@', false], ['@ybl', false], ['ravi', false], ['ravi@ok axis', false],
    ['ravi@ybl1', false],          // provider is letters only
    ['ravi@@ybl', false], ['ra vi@ybl', false], ['ravi@y', false],
    [`${'a'.repeat(65)}@ybl`, false], [`${'a'.repeat(64)}@ybl`, true],
  ])('isValidVpa(%j) → %s', (value, ok) => {
    expect(isValidVpa(value)).toBe(ok);
  });

  it('the pattern itself is anchored (no partial matches)', () => {
    expect(VPA_PATTERN.test('x ravi@ybl')).toBe(false);
    expect(VPA_PATTERN.test('ravi@ybl x')).toBe(false);
  });
});

describe('buildPayee', () => {
  it('a valid UPI ID identifies the payee', () => {
    expect(buildPayee({ payeeVpa: 'Ravi@OKAXIS', merchantName: 'Ravi Stores' })).toEqual({ key: 'vpa:ravi@okaxis', vpa: 'ravi@okaxis' });
  });
  it('without (or with an invalid) UPI ID the normalised merchant name does', () => {
    expect(buildPayee({ merchantName: '  Gadget   Hub ' })).toEqual({ key: 'merchant:gadget hub' });
    expect(buildPayee({ payeeVpa: 'not a vpa', merchantName: 'Gadget Hub' })).toEqual({ key: 'merchant:gadget hub' });
    expect(buildPayee({ payeeVpa: '', merchantName: 'GADGET HUB' })).toEqual({ key: 'merchant:gadget hub' });
  });
  it('a merchant named like a UPI ID never collides with that UPI ID', () => {
    expect(buildPayee({ merchantName: 'ravi@okaxis' }).key).not.toBe(buildPayee({ payeeVpa: 'ravi@okaxis' }).key);
  });
  it('normalizeMerchantName collapses spaces and case', () => {
    expect(normalizeMerchantName('\tBook  Store\n')).toBe('book store');
    expect(normalizeMerchantName(null)).toBe('');
  });
});

describe('isPayeeKey (guards the analyst routes)', () => {
  it.each([
    ['vpa:ravi@okaxis', true], ['merchant:gadget hub', true],
    ['vpa:Ravi@okaxis', false],      // keys are stored normalised: upper case cannot match anything
    ['merchant:Gadget Hub', false], ['merchant:gadget  hub', false], ['merchant:', false],
    ['vpa:not-a-vpa', false], ['ravi@okaxis', false], ['', false],
    [`merchant:${'a'.repeat(215)}`, false],
  ])('%j → %s', (key, ok) => expect(isPayeeKey(key)).toBe(ok));
  it('rejects non-strings', () => {
    expect(isPayeeKey({ $ne: '' })).toBe(false);
    expect(isPayeeKey(['vpa:ravi@okaxis'])).toBe(false);
    expect(isPayeeKey(undefined)).toBe(false);
  });
  it('every key buildPayee produces is accepted', () => {
    for (const input of [{ payeeVpa: 'Ravi@OkAxis' }, { merchantName: '  Book   Store ' }, { merchantName: 'ÉLAN Café' }]) {
      expect(isPayeeKey(buildPayee(input).key)).toBe(true);
    }
  });
  it('prefixes are fixed', () => expect(PAYEE_KEY_PREFIX).toEqual({ VPA: 'vpa:', MERCHANT: 'merchant:' }));
});

describe('payeeLabel and API copies', () => {
  it('shows the UPI ID, else the merchant name', () => {
    expect(payeeLabel({ payee: { vpa: 'ravi@ybl' }, merchantName: 'X' })).toBe('ravi@ybl');
    expect(payeeLabel({ merchantName: 'Book Store' })).toBe('Book Store');
    expect(payeeLabel(null)).toBe('Unknown payee');
  });
  it('the customer sees only their own history and the watchlist flag', () => {
    const signals = { firstTimePayee: true, payeeAgeDays: 0, sendersLast24h: 7, inflowLast24h: 90000, watchlisted: true };
    expect(customerPayeeView(signals)).toEqual({ firstTimePayee: true, watchlisted: true });
    expect(customerPayeeView(undefined)).toBeNull();
    expect(plainPayeeSignals({ ...signals, extra: 1 })).toEqual(signals);
    expect(plainPayeeSignals(null)).toBeNull();
  });
  it('plainPayee copies key and vpa only', () => {
    expect(plainPayee({ key: 'vpa:a1@ybl', vpa: 'a1@ybl', junk: 1 })).toEqual({ key: 'vpa:a1@ybl', vpa: 'a1@ybl' });
    expect(plainPayee({ key: 'merchant:x' })).toEqual({ key: 'merchant:x' });
    expect(plainPayee(undefined)).toBeNull();
    expect(plainPayee({})).toBeNull();
  });
});

describe('submit validator: payeeVpa', () => {
  it('is optional (absent, empty, blank, null)', async () => {
    for (const extra of [{}, { payeeVpa: '' }, { payeeVpa: '   ' }, { payeeVpa: null }]) {
      const { errors } = await run(submitTransactionRules, { body: goodPayment(extra) });
      expect(errors).toEqual([]);
    }
  });
  it('is normalised when valid', async () => {
    const { errors, req } = await run(submitTransactionRules, { body: goodPayment({ payeeVpa: '  Ravi@OkAxis ' }) });
    expect(errors).toEqual([]);
    expect(req.body.payeeVpa).toBe('ravi@okaxis');
  });
  it.each([['ravi'], [['ravi@ybl']], [{ $ne: '' }], [12345], ['a'.repeat(101)], ['ravi@ybl1']])('rejects %j', async (payeeVpa) => {
    const { errors } = await run(submitTransactionRules, { body: goodPayment({ payeeVpa }) });
    expect(errors.map((e) => e.path)).toEqual(['payeeVpa']);
    expect(errors[0].msg).toMatch(/name@bank/);
  });
});

describe('watchlist validators', () => {
  it('add: exactly one of vpa / merchantName', async () => {
    expect((await run(addWatchlistRules, { body: { vpa: 'Mule01@YBL', note: ' seen in 3 cases ' } })).errors).toEqual([]);
    expect((await run(addWatchlistRules, { body: { merchantName: 'Lucky Prize Desk' } })).errors).toEqual([]);
    const both = await run(addWatchlistRules, { body: { vpa: 'mule01@ybl', merchantName: 'X' } });
    expect(both.errors[0].msg).toMatch(/either/);
    const neither = await run(addWatchlistRules, { body: { note: 'x' } });
    expect(neither.errors[0].msg).toMatch(/either/);
  });
  it('add: normalises the UPI ID and trims the note', async () => {
    const { req } = await run(addWatchlistRules, { body: { vpa: ' Mule01@YBL ', note: '  n  ' } });
    expect(req.body).toMatchObject({ vpa: 'mule01@ybl', note: 'n' });
  });
  it('add: rejects bad values', async () => {
    expect((await run(addWatchlistRules, { body: { vpa: 'nope' } })).errors.map((e) => e.path)).toContain('vpa');
    expect((await run(addWatchlistRules, { body: { vpa: { $gt: '' } } })).errors.map((e) => e.path)).toContain('vpa');
    expect((await run(addWatchlistRules, { body: { merchantName: '   ' } })).errors[0].msg).toMatch(/either/); // blank = not given
    expect((await run(addWatchlistRules, { body: { vpa: '  ', merchantName: 'Shop' } })).errors).toEqual([]);
    expect((await run(addWatchlistRules, { body: { vpa: 'ok12@ybl', note: 'x'.repeat(301) } })).errors.map((e) => e.path)).toEqual(['note']);
    expect((await run(addWatchlistRules, { body: { vpa: 'ok12@ybl', note: 5 } })).errors.map((e) => e.path)).toEqual(['note']);
  });
  it('remove: needs a Mongo id', async () => {
    expect((await run(removeWatchlistRules, { params: { id: '64b7f0c2a1b2c3d4e5f60718' } })).errors).toEqual([]);
    expect((await run(removeWatchlistRules, { params: { id: 'abc' } })).errors.map((e) => e.path)).toEqual(['id']);
  });
  it('list: status filter', async () => {
    for (const status of [undefined, '', 'active', 'removed', 'all']) {
      expect((await run(listWatchlistRules, { query: status === undefined ? {} : { status } })).errors).toEqual([]);
    }
    expect((await run(listWatchlistRules, { query: { status: 'gone' } })).errors.length).toBe(1);
    expect((await run(listWatchlistRules, { query: { status: ['all'] } })).errors.length).toBe(1);
  });
  it('profile: key must be a valid payee key and a string', async () => {
    expect((await run(payeeProfileRules, { query: { key: 'vpa:mule01@ybl' } })).errors).toEqual([]);
    expect((await run(payeeProfileRules, { query: { key: 'merchant:book store' } })).errors).toEqual([]);
    for (const key of [undefined, '', 'mule01@ybl', ['vpa:mule01@ybl'], { $ne: '' }]) {
      expect((await run(payeeProfileRules, { query: key === undefined ? {} : { key } })).errors.length).toBe(1);
    }
  });
});
