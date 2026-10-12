// src/api/__tests__/axios.test.js
// AUD-31: FormData uploads are not converted to JSON. E-20 / E-01 / F-07: 401 redirect, deactivated
// accounts, cold-start retry (GET only), wake-before-write for mutations, signals.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import api from '../axios.js';
import { markServerContact, msSinceServerContact, waitForServer } from '../serverHealth.js';
import { peekSessionNotice, clearSessionNotice, endSessionRequests, DEACTIVATED_NOTICE } from '../session.js';

vi.mock('../serverHealth.js', () => ({
  markServerContact: vi.fn(),
  msSinceServerContact: vi.fn(() => 0),
  waitForServer: vi.fn(async () => true),
}));

/** Adapter that answers every call with the next outcome of `script` (an Error is thrown, else returned). */
function scripted(...script) {
  const calls = [];
  const adapter = async (config) => {
    calls.push(config);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (typeof step === 'function') return step(config);
    return step;
  };
  adapter.calls = calls;
  return adapter;
}
const okReply = (config, data = {}) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
const httpError = (status, data = {}) => (config) => {
  throw new axios.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, {
    status, data, statusText: '', headers: {}, config,
  });
};
const networkError = (config) => { throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config); };

const stubPath = (pathname) => {
  const loc = { pathname, href: `http://localhost${pathname}` };
  vi.stubGlobal('location', loc);
  return loc;
};

beforeEach(() => {
  vi.clearAllMocks();
  msSinceServerContact.mockReturnValue(0);
  waitForServer.mockResolvedValue(true);
  clearSessionNotice();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('sends FormData unchanged (profile image upload) and plain objects as JSON', async () => {
  const seen = [];
  const adapter = async (config) => {
    seen.push({ data: config.data, type: config.headers.getContentType() });
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  const fd = new FormData();
  fd.append('profileImage', new Blob(['x'], { type: 'image/png' }), 'a.png');
  await api.patch('/customer-api/profile', fd, { adapter });
  await api.post('/customer-api/transactions', { amount: 5 }, { adapter });

  expect(seen[0].data).toBeInstanceOf(FormData);          // not JSON.stringify'd
  expect(String(seen[0].type)).not.toMatch(/json/);
  expect(seen[1]).toMatchObject({ data: '{"amount":5}' });
  expect(String(seen[1].type)).toMatch(/application\/json/);
});

describe('401 handling (C-P9-01)', () => {
  it('redirects to /login on a 401 from a normal request', async () => {
    const loc = stubPath('/customer');
    await expect(api.get('/customer-api/transactions', { adapter: scripted(httpError(401, { message: 'Authentication required' })) }))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(loc.href).toBe('/login');
  });

  it('does NOT redirect for the silent session probe (check-auth) — the auth slice handles it', async () => {
    const loc = stubPath('/customer');
    await expect(api.get('/auth/check-auth', { adapter: scripted(httpError(401)) })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/customer');
  });

  it.each(['/login', '/register'])('does NOT redirect while already on the public page %s', async (path) => {
    const loc = stubPath(path);
    await expect(api.post('/auth/login', {}, { adapter: scripted(httpError(401, { message: 'Invalid credentials' })) })).rejects.toBeTruthy();
    expect(loc.href).toBe(`http://localhost${path}`);
  });

  it('E-01: a failed sign-out (401) is not redirected — the Navbar already navigates to /login', async () => {
    const loc = stubPath('/customer');
    await expect(api.post('/auth/logout', undefined, { adapter: scripted(httpError(401)) })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/customer');
  });

  it('other statuses (403, 404, 500) never redirect and are passed through', async () => {
    const loc = stubPath('/customer');
    for (const status of [403, 404, 500]) {
      await expect(api.get('/x', { adapter: scripted(httpError(status, { message: 'Forbidden' })) })).rejects.toMatchObject({ response: { status } });
    }
    expect(loc.href).toBe('http://localhost/customer');
  });
});

describe('E-01: deactivated accounts', () => {
  it('401 with code ACCOUNT_DEACTIVATED redirects to /login and leaves the notice for the login page', async () => {
    const loc = stubPath('/analyst/cases');
    await expect(api.get('/analyst-api/cases', {
      adapter: scripted(httpError(401, { message: 'Account has been deactivated', code: 'ACCOUNT_DEACTIVATED' })),
    })).rejects.toBeTruthy();
    expect(loc.href).toBe('/login');
    expect(peekSessionNotice()).toBe(DEACTIVATED_NOTICE);
    expect(DEACTIVATED_NOTICE).toBe('Account has been deactivated. Contact support.');
  });

  it('a 403 whose message says "deactivated" (older backend) is handled the same way', async () => {
    const loc = stubPath('/customer');
    await expect(api.get('/customer-api/trust-score', { adapter: scripted(httpError(403, { message: 'Account has been DEACTIVATED' })) })).rejects.toBeTruthy();
    expect(loc.href).toBe('/login');
    expect(peekSessionNotice()).toBe(DEACTIVATED_NOTICE);
  });

  it('the admin route 403 "ADMIN accounts cannot be activated or deactivated via the API." does NOT log an admin out (R-03)', async () => {
    const loc = stubPath('/admin/users');
    await expect(api.patch('/admin-api/users/x/status', { isActive: false }, {
      adapter: scripted(httpError(403, { message: 'ADMIN accounts cannot be activated or deactivated via the API.' })),
    })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/admin/users');
    expect(peekSessionNotice()).toBe('');
  });

  it('an ordinary 403 (role not allowed) is NOT treated as a deactivation', async () => {
    const loc = stubPath('/customer');
    await expect(api.get('/admin-api/users', { adapter: scripted(httpError(403, { message: 'Access denied for your role' })) })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/customer');
    expect(peekSessionNotice()).toBe('');
  });

  it('an ordinary 401 leaves no deactivation notice', async () => {
    stubPath('/customer');
    await expect(api.get('/x', { adapter: scripted(httpError(401, { message: 'Token expired' })) })).rejects.toBeTruthy();
    expect(peekSessionNotice()).toBe('');
  });

  it('the session probe keeps the notice (no hard redirect) so a refresh that ends on /login can explain itself', async () => {
    const loc = stubPath('/customer');
    await expect(api.get('/auth/check-auth', { adapter: scripted(httpError(401, { code: 'ACCOUNT_DEACTIVATED', message: 'x' })) })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/customer');
    expect(peekSessionNotice()).toBe(DEACTIVATED_NOTICE);
  });

  it('on the login page itself (403 from POST /auth/login) nothing is stored or redirected', async () => {
    const loc = stubPath('/login');
    await expect(api.post('/auth/login', {}, { adapter: scripted(httpError(403, { message: 'Account has been deactivated' })) })).rejects.toBeTruthy();
    expect(loc.href).toBe('http://localhost/login');
    expect(peekSessionNotice()).toBe('');
  });
});

describe('cold start (Render free tier)', () => {
  it('a GET that gets no response waits for /health and is retried ONCE', async () => {
    const adapter = scripted(networkError, (config) => okReply(config, { ok: 1 }));
    const res = await api.get('/customer-api/transactions', { adapter });
    expect(res.data).toEqual({ ok: 1 });
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(adapter.calls).toHaveLength(2);
  });

  it.each([502, 503, 504])('a GET answered with %i is retried once', async (status) => {
    const adapter = scripted(httpError(status), (config) => okReply(config));
    await api.get('/x', { adapter });
    expect(adapter.calls).toHaveLength(2);
  });

  it('is not retried a second time (the retry fails → the error reaches the caller)', async () => {
    const adapter = scripted(networkError);
    await expect(api.get('/x', { adapter })).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    expect(adapter.calls).toHaveLength(2);
    expect(waitForServer).toHaveBeenCalledTimes(1);
  });

  it('when the server never wakes up the original error is returned and nothing is re-sent', async () => {
    waitForServer.mockResolvedValue(false);
    const adapter = scripted(networkError);
    await expect(api.get('/x', { adapter })).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    expect(adapter.calls).toHaveLength(1);
  });

  it('a real API error (400/404/422) is not a cold start: no wait, no retry', async () => {
    const adapter = scripted(httpError(404, { message: 'nope' }));
    await expect(api.get('/x', { adapter })).rejects.toMatchObject({ response: { status: 404 } });
    expect(adapter.calls).toHaveLength(1);
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it.each(['post', 'patch', 'put', 'delete'])('%s is NEVER retried (a duplicate payment must be impossible)', async (method) => {
    const adapter = scripted(networkError);
    await expect(api[method]('/customer-api/transactions', method === 'delete' ? { adapter } : { a: 1 }, { adapter })).rejects.toBeTruthy();
    expect(adapter.calls).toHaveLength(1);
  });

  it('a 503 on POST is not retried either', async () => {
    const adapter = scripted(httpError(503));
    await expect(api.post('/customer-api/transactions', {}, { adapter })).rejects.toBeTruthy();
    expect(adapter.calls).toHaveLength(1);
  });

  it('any HTTP answer except 502/503/504 marks the server as awake', async () => {
    await expect(api.get('/x', { adapter: scripted(httpError(422)) })).rejects.toBeTruthy();
    expect(markServerContact).toHaveBeenCalled();
    markServerContact.mockClear();
    await expect(api.get('/x', { adapter: scripted(httpError(503), httpError(503)) })).rejects.toBeTruthy();
    expect(markServerContact).not.toHaveBeenCalled();
  });
});

describe('wake-before-write', () => {
  it('a mutation waits for /health when the API may be asleep (>10 min of silence)', async () => {
    msSinceServerContact.mockReturnValue(11 * 60 * 1000);
    const adapter = scripted((config) => okReply(config));
    await api.post('/customer-api/transactions', { amount: 1 }, { adapter });
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(adapter.calls).toHaveLength(1);
  });

  it('...and is not sent at all (nothing can be half-saved) when the server does not wake up', async () => {
    msSinceServerContact.mockReturnValue(Number.POSITIVE_INFINITY);
    waitForServer.mockResolvedValue(false);
    const adapter = scripted((config) => okReply(config));
    await expect(api.post('/customer-api/transactions', { amount: 1 }, { adapter }))
      .rejects.toMatchObject({ code: 'ERR_NETWORK', message: expect.stringMatching(/not reachable/i) });
    expect(adapter.calls).toHaveLength(0);
  });

  it('a recently answered server is not probed first', async () => {
    const adapter = scripted((config) => okReply(config));
    await api.patch('/x', {}, { adapter });
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it('GET requests never wait first (they are retried afterwards instead)', async () => {
    msSinceServerContact.mockReturnValue(Number.POSITIVE_INFINITY);
    const adapter = scripted((config) => okReply(config));
    await api.get('/x', { adapter });
    expect(waitForServer).not.toHaveBeenCalled();
  });
});

describe('request cancellation (AUD-40 / F-07)', () => {
  it('every request carries the session signal; ending the session aborts it', async () => {
    let pending;
    const adapter = (config) => new Promise((resolve, reject) => {
      pending = config.signal;
      config.signal.addEventListener('abort', () => reject(new axios.CanceledError('canceled', config)));
    });
    const request = api.get('/x', { adapter });
    await vi.waitFor(() => expect(pending).toBeInstanceOf(AbortSignal));
    endSessionRequests();
    await expect(request).rejects.toSatisfy((e) => axios.isCancel(e));
  });

  it('F-07: a caller-supplied signal also cancels, and the session still can', async () => {
    const own = new AbortController();
    const seen = [];
    const adapter = (config) => new Promise((resolve, reject) => {
      seen.push(config.signal);
      config.signal.addEventListener('abort', () => reject(new axios.CanceledError('canceled', config)));
    });
    const request = api.get('/x', { adapter, signal: own.signal });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    own.abort();
    await expect(request).rejects.toSatisfy((e) => axios.isCancel(e));

    const second = api.get('/y', { adapter, signal: new AbortController().signal });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    endSessionRequests();
    await expect(second).rejects.toSatisfy((e) => axios.isCancel(e));
  });
});
