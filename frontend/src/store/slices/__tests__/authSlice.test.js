// src/store/slices/__tests__/authSlice.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import authReducer, { loginThunk, logoutThunk, checkAuthThunk, registerThunk, changePasswordThunk } from '../authSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { post: vi.fn(), get: vi.fn(), patch: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = (preloadedState) => configureStore({ reducer: { auth: authReducer }, preloadedState });
const USER = { id: 'u1', name: 'Asha', email: 'a@b.com', role: 'CUSTOMER', profileImage: '', trustScore: 50 };

beforeEach(() => vi.clearAllMocks());

describe('initial state (AUD-12)', () => {
  it('starts in loading state until the first session check settles', () => {
    expect(makeStore().getState().auth).toMatchObject({ loading: true, isAuthenticated: false });
  });
});

describe('checkAuthThunk', () => {
  it('restores the session (Phase 4 flat user in data.data)', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: USER } });
    const store = makeStore();
    await store.dispatch(checkAuthThunk());
    expect(store.getState().auth).toMatchObject({ loading: false, isAuthenticated: true, user: USER });
  });
  it('401 → not authenticated and not loading', async () => {
    api.get.mockRejectedValueOnce({ response: { status: 401, data: { message: 'Authentication required.' } } });
    const store = makeStore();
    await store.dispatch(checkAuthThunk());
    expect(store.getState().auth).toMatchObject({ loading: false, isAuthenticated: false });
  });
});

describe('loginThunk', () => {
  it('sets the user on success', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: USER } });
    const store = makeStore();
    await store.dispatch(loginThunk({ email: 'a@b.com', password: 'x' }));
    expect(store.getState().auth).toMatchObject({ isAuthenticated: true, error: null, user: USER });
  });
  it('stores the server message on failure', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { message: 'Invalid email or password.' } } });
    const store = makeStore();
    await store.dispatch(loginThunk({ email: 'a@b.com', password: 'bad' }));
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false, error: 'Invalid email or password.' });
  });
});

describe('registerThunk (AUD-11)', () => {
  it('does NOT authenticate — the backend sets no cookie on register', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 'n1', email: 'n@b.com', role: 'CUSTOMER' } } });
    const store = makeStore();
    const action = await store.dispatch(registerThunk({ name: 'N', email: 'n@b.com', password: 'Password@123', role: 'CUSTOMER' }));
    expect(action.type).toBe('auth/register/fulfilled');
    expect(api.post).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ role: 'CUSTOMER' }));
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false, loading: false });
  });
});

describe('logout and change password', () => {
  const authed = { auth: { user: USER, isAuthenticated: true, loading: false, error: null } };

  it('logout resets to a logged-out, non-loading state', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true } });
    const store = makeStore(authed);
    await store.dispatch(logoutThunk());
    const { auth } = store.getState();
    expect(auth).toMatchObject({ isAuthenticated: false, loading: false });
    expect(auth.user.id).toBeNull();
  });

  it('change password uses PATCH (C-P6-34) and logs the client out (session cleared server-side)', async () => {
    api.patch.mockResolvedValueOnce({ data: { success: true } });
    const store = makeStore(authed);
    const action = await store.dispatch(changePasswordThunk({ currentPassword: 'a', newPassword: 'b' }));
    expect(action.type).toContain('fulfilled');
    expect(api.patch).toHaveBeenCalledWith('/auth/change-password', { currentPassword: 'a', newPassword: 'b' });
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false, loading: false });
  });
});
