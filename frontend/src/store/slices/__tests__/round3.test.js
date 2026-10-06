// src/store/slices/__tests__/round3.test.js — Phase 1–9 audit, round 3 (AUD-40, AUD-41)
// Uses the REAL axios instance with a test adapter that honours AbortSignal,
// exactly like the browser adapters (xhr/fetch) do.
import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import axios from 'axios';
import api from '../../../api/axios.js';
import { markServerContact } from '../../../api/serverHealth.js';
import { rootReducer } from '../../index.js';
import { checkAuthThunk, loginThunk, logoutThunk } from '../authSlice.js';
import { fetchTransactionsThunk } from '../transactionSlice.js';

/** Adapter whose responses the test releases by URL. */
function controllableAdapter() {
  const pending = new Map();
  const adapter = (config) => new Promise((resolve, reject) => {
    const respond = (status, data) => {
      const response = { data, status, statusText: String(status), headers: {}, config };
      if (status >= 400) reject(new axios.AxiosError('HTTP ' + status, 'ERR_BAD_REQUEST', config, null, response));
      else resolve(response);
    };
    config.signal?.addEventListener('abort', () => reject(new axios.CanceledError(undefined, undefined, config)));
    pending.set(config.url, respond);
  });
  const release = (url, status, data) => pending.get(url)(status, data);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { adapter, release, tick };
}

const USER = (name) => ({ id: name, name, role: 'CUSTOMER' });

describe('AUD-40: requests from an ended session cannot refill the store', () => {
  it('a transaction list that answers after logout is discarded', async () => {
    markServerContact(); // server is awake (no wake-before-write wait)
    const { adapter, release, tick } = controllableAdapter();
    api.defaults.adapter = adapter;
    const store = configureStore({ reducer: rootReducer });

    const list = store.dispatch(fetchTransactionsThunk());       // user A's page is loading…
    await tick();
    const logout = store.dispatch(logoutThunk());                  // …and A logs out
    await tick();
    release('/auth/logout', 200, { success: true });
    await logout;
    try { release('/customer-api/transactions', 200, { success: true, data: [{ _id: 't1', owner: 'A' }], pagination: { total: 1, page: 1, limit: 10 } }); } catch { /* already aborted */ }
    await list;

    expect(store.getState().transactions.transactions).toEqual([]);
    expect(store.getState().auth.isAuthenticated).toBe(false);
  });
});

describe('AUD-41: a slow session check cannot undo a login', () => {
  it('check-auth 401 arriving after a successful login is ignored', async () => {
    markServerContact();
    const { adapter, release, tick } = controllableAdapter();
    api.defaults.adapter = adapter;
    const store = configureStore({ reducer: rootReducer });

    const check = store.dispatch(checkAuthThunk());   // App mount, no cookie yet
    await tick();
    const login = store.dispatch(loginThunk({ email: 'b@x.com', password: 'p' }));
    await tick();
    release('/auth/login', 200, { success: true, data: USER('B') });
    await login;
    try { release('/auth/check-auth', 401, { success: false, message: 'Authentication required.' }); } catch { /* already aborted */ }
    await check;

    expect(store.getState().auth).toMatchObject({ isAuthenticated: true, loading: false, user: { id: 'B' } });
  });
});
