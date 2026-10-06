// src/store/slices/__tests__/sliceLifecycle.test.js
// Every async thunk: a failed request must never leave a slice stuck in `loading`,
// and plain reducers (filters / clear actions) must behave as documented.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const { fail } = vi.hoisted(() => ({
  fail: () => Promise.reject({ response: { status: 500, data: { message: 'boom' } } }),
}));
vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(fail), post: vi.fn(fail), patch: vi.fn(fail) } }));

import api from '../../../api/axios.js';
import * as auth from '../authSlice.js';
import * as transactions from '../transactionSlice.js';
import * as fraudAlerts from '../fraudAlertSlice.js';
import * as fraudCases from '../fraudCaseSlice.js';
import * as notifications from '../notificationSlice.js';
import * as analytics from '../analyticsSlice.js';
import * as simulation from '../simulationSlice.js';

// N-10: the "network failure" test below replaces the mock implementations; put the 500 behaviour
// back after every test so no test depends on the order the others ran in.
afterEach(() => {
  for (const method of ['get', 'post', 'patch']) {
    api[method].mockReset();
    api[method].mockImplementation(fail);
  }
});

const slices = { auth, transactions, fraudAlerts, fraudCases, notifications, analytics, simulation };
const thunkArg = { id: 'x', status: 'OPEN', note: 'n' };

describe.each(Object.entries(slices))('%s slice', (name, mod) => {
  const thunks = Object.entries(mod).filter(([key]) => key.endsWith('Thunk'));

  it.each(thunks.map(([k]) => [k]))('%s rejects with a message and clears loading', async (key) => {
    // auth starts in the settled, signed-in-app state (loading false): its thunks
    // other than checkAuth only run after the first session check (AUD-12, AUD-35).
    const preloadedState = name === 'auth'
      ? { auth: { ...mod.default(undefined, { type: '@@INIT' }), loading: false } }
      : undefined;
    const store = configureStore({ reducer: { [name]: mod.default }, preloadedState });
    const action = await store.dispatch(mod[key](thunkArg));
    expect(action.type.endsWith('/rejected')).toBe(true);
    expect(typeof action.payload).toBe('string');
    const state = store.getState()[name];
    if ('loading' in state) expect(state.loading).toBe(false);
  });
});

describe('network failure without a response body falls back to a readable message', () => {
  it.each(Object.entries(slices))('%s slice', async (name, mod) => {
    for (const method of ['get', 'post', 'patch']) api[method].mockImplementation(() => Promise.reject(new Error('Network Error')));
    const store = configureStore({ reducer: { [name]: mod.default } });
    for (const [key, thunk] of Object.entries(mod).filter(([k]) => k.endsWith('Thunk'))) {
      const action = await store.dispatch(thunk(thunkArg));
      expect(action.payload, key).toEqual(expect.any(String));
      expect(action.payload.length, key).toBeGreaterThan(0);
    }
  });
});

describe('plain reducers', () => {
  it('transactions: setTransactionFilters merges, clearSelectedTransaction clears', () => {
    const store = configureStore({ reducer: { t: transactions.default } });
    store.dispatch(transactions.setTransactionFilters({ riskLevel: 'HIGH' }));
    expect(store.getState().t.filters.riskLevel).toBe('HIGH');
    store.dispatch(transactions.clearSelectedTransaction());
    expect(store.getState().t.selectedTransaction).toBeNull();
  });
  it('fraudAlerts: setAlertFilters, clearSelectedAlert, clearSelectedFlagged', () => {
    const store = configureStore({ reducer: { a: fraudAlerts.default } });
    store.dispatch(fraudAlerts.setAlertFilters({ status: 'OPEN' }));
    store.dispatch(fraudAlerts.clearSelectedAlert());
    store.dispatch(fraudAlerts.clearSelectedFlagged());
    expect(store.getState().a).toMatchObject({ filters: { status: 'OPEN' }, selectedAlert: null, selectedFlagged: null });
  });
  it('fraudCases: setCaseFilters, clearSelectedCase', () => {
    const store = configureStore({ reducer: { c: fraudCases.default } });
    store.dispatch(fraudCases.setCaseFilters({ assignedToMe: true }));
    store.dispatch(fraudCases.clearSelectedCase());
    expect(store.getState().c).toMatchObject({ filters: { assignedToMe: true }, selectedCase: null });
  });
  it('auth: clearAuthError, updateUser', () => {
    const store = configureStore({ reducer: { a: auth.default } });
    store.dispatch(auth.updateUser({ name: 'New' }));
    store.dispatch(auth.clearAuthError());
    expect(store.getState().a).toMatchObject({ error: null, user: { name: 'New' } });
  });
  it('simulation: live start/stop/clear', () => {
    const store = configureStore({ reducer: { s: simulation.default } });
    store.dispatch(simulation.startSimulationLive({ transactionCount: 5 }));
    store.dispatch(simulation.addSimulationEvent({ n: 1 }));
    store.dispatch(simulation.stopSimulationLive({ stoppedBy: 'a' }));
    store.dispatch(simulation.clearSimulationEvents());
    expect(store.getState().s).toMatchObject({ isRunning: false, events: [], stats: { transactionCount: 5, stoppedBy: 'a' } });
  });
});
