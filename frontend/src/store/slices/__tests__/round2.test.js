// src/store/slices/__tests__/round2.test.js — Phase 1–9 audit, round 2 (AUD-30 … AUD-35)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../../api/axios.js';
import { rootReducer } from '../../index.js';
import authReducer, { logoutThunk, changePasswordThunk, loginThunk } from '../authSlice.js';
import transactionReducer, { fetchTransactionsThunk, submitTransactionThunk } from '../transactionSlice.js';
import { addLiveNotification } from '../notificationSlice.js';
import analyticsReducer, { fetchAnalyticsThunk } from '../analyticsSlice.js';
import { addSimulationEvent } from '../simulationSlice.js';

const makeStore = () => configureStore({ reducer: rootReducer });            // AUD-30 (whole app)
const makeSliceStore = () => configureStore({                                // AUD-32 … 35 (slices only)
  reducer: { auth: authReducer, transactions: transactionReducer, analytics: analyticsReducer },
});
beforeEach(() => vi.clearAllMocks());

async function storeWithUserAData() {
  const store = makeStore();
  api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 'A', role: 'CUSTOMER' } } });
  await store.dispatch(loginThunk({ email: 'a@x.com', password: 'p' }));
  api.get.mockResolvedValueOnce({ data: { success: true, data: [{ _id: 'A1', amount: 999 }], pagination: { total: 1, page: 1, limit: 10 } } });
  await store.dispatch(fetchTransactionsThunk());
  store.dispatch(addLiveNotification({ id: 'n1', message: 'userA secret' }));
  store.dispatch(addSimulationEvent({ publicId: 'TXN-A' }));
  return store;
}

describe('AUD-30: ending a session clears every slice', () => {
  it.each([
    ['logout fulfilled', () => api.post.mockResolvedValueOnce({ data: { success: true } }), logoutThunk],
    // F-04: a failed logout request still wipes the local session (the cookie may stay valid
    // until it expires — the Navbar test checks that the user is told so honestly)
    ['logout rejected (server unreachable)', () => api.post.mockRejectedValueOnce({ response: { data: { message: 'x' } } }), logoutThunk],
    ['password changed', () => api.patch.mockResolvedValueOnce({ data: { success: true } }), () => changePasswordThunk({ currentPassword: 'a', newPassword: 'b' })],
  ])('%s', async (_label, mock, thunk) => {
    const store = await storeWithUserAData();
    mock();
    await store.dispatch(thunk());
    const s = store.getState();
    expect(s.auth).toMatchObject({ isAuthenticated: false, loading: false });
    expect(s.transactions.transactions).toEqual([]);
    expect(s.notifications).toMatchObject({ notifications: [], unreadCount: 0 });
    expect(s.simulation.events).toEqual([]);
  });
});

describe('AUD-32: validation (422) messages reach the UI', () => {
  it('changePasswordThunk surfaces errors[0].msg', async () => {
    api.patch.mockRejectedValueOnce({ response: { status: 422, data: { success: false, errors: [{ msg: 'New password must be different from the current password' }] } } });
    const action = await makeSliceStore().dispatch(changePasswordThunk({ currentPassword: 'a', newPassword: 'a' }));
    expect(action.payload).toBe('New password must be different from the current password');
  });
  it('submitTransactionThunk surfaces errors[0].msg', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 422, data: { success: false, errors: [{ msg: 'Device ID is required' }] } } });
    const action = await makeSliceStore().dispatch(submitTransactionThunk({}));
    expect(action.payload).toBe('Device ID is required');
  });
});

describe('AUD-33: analytics keeps the KPI numbers', () => {
  it('stores totalTransactions, fraudRate, openCases, openAlerts', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: { totalTransactions: 42, fraudRate: 7.5, openCases: 3, openAlerts: 4, lossPrevented: 10 } } });
    const store = makeSliceStore();
    await store.dispatch(fetchAnalyticsThunk());
    expect(store.getState().analytics).toMatchObject({ totalTransactions: 42, fraudRate: 7.5, openCases: 3, openAlerts: 4, lossPrevented: 10 });
  });
});

describe('AUD-34: a submitted transaction uses the same _id key as list items', () => {
  it('normalises id → _id and bumps the total', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 'T9', publicId: 'TXN-2026-00009' } } });
    const store = makeSliceStore();
    await store.dispatch(submitTransactionThunk({ amount: 1 }));
    expect(store.getState().transactions.transactions[0]._id).toBe('T9');
    expect(store.getState().transactions.pagination.total).toBe(1);
  });
});

describe('AUD-35: change password does not toggle the global auth.loading', () => {
  it('keeps loading false while the request is pending', async () => {
    let resolve;
    api.patch.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const store = makeSliceStore();
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 'A', role: 'CUSTOMER' } } });
    await store.dispatch(loginThunk({ email: 'a@x.com', password: 'p' }));
    const pending = store.dispatch(changePasswordThunk({ currentPassword: 'a', newPassword: 'b' }));
    expect(store.getState().auth.loading).toBe(false); // ProtectedRoute keeps the page mounted
    resolve({ data: { success: true } });
    await pending;
  });
});
