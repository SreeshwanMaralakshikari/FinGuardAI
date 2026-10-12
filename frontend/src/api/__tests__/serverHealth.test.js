// serverHealth: single probe rules, last-contact bookkeeping, polling loop (E-20 / T-02)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pingServer, waitForServer, markServerContact, msSinceServerContact } from '../serverHealth.js';

const reply = (body, { ok = true } = {}) => ({ ok, json: async () => body });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('pingServer', () => {
  it('is ready only for a 2xx JSON body {status:"ok"}, and calls /health without cookies or caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pingServer()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/health$/);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a non-2xx answer', reply({ status: 'ok' }, { ok: false })],
    ['a 2xx whose JSON says something else (booting)', reply({ status: 'starting' })],
    ['a JSON body without a status', reply({})],
    ['a null body', reply(null)],
  ])('is NOT ready for %s', async (_name, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(pingServer()).resolves.toBe(false);
  });

  it('is NOT ready when the body is not JSON (an HTML placeholder page from a proxy)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await expect(pingServer()).resolves.toBe(false);
  });

  it('is NOT ready on a network / CORS / timeout failure (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(pingServer()).resolves.toBe(false);
  });

  it('a ready probe records server contact; a failed one does not', async () => {
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ status: 'ok' })));
    await pingServer();
    vi.setSystemTime(new Date('2026-10-12T10:00:05Z'));
    expect(msSinceServerContact()).toBe(5000);
  });
});

describe('contact bookkeeping', () => {
  it('msSinceServerContact grows with time after markServerContact', () => {
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    markServerContact();
    vi.advanceTimersByTime(12_000);
    expect(msSinceServerContact()).toBe(12_000);
  });
});

describe('waitForServer', () => {
  it('polls every interval until the API answers', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValueOnce(reply({ status: 'starting' }))
      .mockResolvedValueOnce(reply({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const promise = waitForServer({ intervalMs: 1000, maxWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up with false once maxWaitMs has passed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const promise = waitForServer({ intervalMs: 1000, maxWaitMs: 3500, attemptTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe(false);
  });

  it('concurrent callers share ONE polling loop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const a = waitForServer();
    const b = waitForServer();
    expect(b).toBe(a);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a later call starts a fresh loop once the previous one has finished', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await waitForServer();
    await waitForServer();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
