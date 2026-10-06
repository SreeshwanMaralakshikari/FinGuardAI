// src/tests/utils.jsx — shared helpers for component / page tests (not part of the app bundle)
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';
import { rootReducer } from '../store/index.js';

/** A signed-in auth slice state for preloadedState. */
export const signedIn = (user) => ({
  user: { id: 'u1', name: 'Test User', email: 't@example.com', role: 'CUSTOMER', profileImage: null, trustScore: 50, ...user },
  isAuthenticated: true,
  loading: false,
  error: null,
  checkAuthRequestId: null,
});

/**
 * Renders `ui` with the REAL root reducer (so every slice has its true initial state) inside a
 * MemoryRouter. `auth` is merged over the real initial auth state; pass `signedIn({...})`.
 */
export function renderApp(ui, { route = '/', auth, preloadedState } = {}) {
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: auth ? { ...preloadedState, auth } : preloadedState,
  });
  const result = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </Provider>,
  );
  return { store, ...result };
}

/** Axios-shaped success / failure for mocked api calls. */
export const ok = (data, extra = {}) => ({ data: { success: true, data, ...extra } });
export const page = (rows, total = rows.length, p = 1, limit = 10) => ({
  data: { success: true, data: rows, pagination: { total, page: p, limit, pages: Math.max(1, Math.ceil(total / limit)) } },
});
export const fail = (status, message, extra = {}) => ({ response: { status, data: { success: false, message, ...extra } } });
