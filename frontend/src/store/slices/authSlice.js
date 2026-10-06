/**
 * @file src/store/slices/authSlice.js
 * @description Redux slice for authentication state.
 *   State: { user, isAuthenticated, loading, error }
 *   Thunks: loginThunk, logoutThunk, registerThunk, checkAuthThunk, changePasswordThunk
 *
 *   Response unwrapping (D-P6-23, C-P6-12..C-P6-14):
 *     Phase 4 wraps all responses: { success, data: <payload> }
 *     `const { data } = await api.xxx()` → data = response.data = full JSON body
 *     Payload is at data.data — NOT data.user / data.token / etc.
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-08, D-P6-03, D-P6-23
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage } from '../../api/errors.js'; // AUD-32
import { endSessionRequests } from '../../api/session.js'; // AUD-40

// ─── Initial State ────────────────────────────────────────────────────────────

const initialState = {
  user: {
    id:           null,
    name:         null,
    email:        null,
    role:         null,
    profileImage: null,
    trustScore:   null,
  },
  isAuthenticated: false,
  // AUD-12: true until the first checkAuthThunk settles. With false, the very
  // first render of ProtectedRoute saw "not loading, not authenticated" and
  // redirected to /login before the session check ran — every hard refresh of
  // a protected page ended on /login (verified in Chromium, 4/4 runs).
  loading:         true,
  error:           null,
  // AUD-41: requestId of the session check whose result still counts. A login
  // clears it, so a slow check-auth 401 that arrives AFTER a successful login
  // can no longer log the user straight out again.
  checkAuthRequestId: null,
};

/** Logged-out state after logout / password change — the session is known, so not loading. */
const loggedOutState = { ...initialState, loading: false };

// ─── Thunks ───────────────────────────────────────────────────────────────────

/**
 * Check if the current HTTP-only cookie session is valid.
 * Called on App mount to restore auth state after a hard refresh.
 * Phase 4 response: { success, data: { id, name, email, role, profileImage, trustScore, isActive } }
 */
export const checkAuthThunk = createAsyncThunk(
  'auth/checkAuth',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.AUTH.CHECK_AUTH);
      return data.data; // C-P6-12: was data.user (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Session expired'));
    }
  },
);

/**
 * Login with email + password credentials.
 * Phase 4 response: { success, message, data: { id, name, email, role, profileImage, trustScore } }
 * @param {{ email: string, password: string }} credentials
 */
export const loginThunk = createAsyncThunk(
  'auth/login',
  async (credentials, { rejectWithValue }) => {
    endSessionRequests(); // AUD-40: drop anything still loading from a previous session
    try {
      const { data } = await api.post(API_PATHS.AUTH.LOGIN, credentials);
      return data.data; // C-P6-13: was data.user (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Login failed'));
    }
  },
);

/**
 * Logout — clears server-side session (cookie cleared by Set-Cookie header).
 */
export const logoutThunk = createAsyncThunk(
  'auth/logout',
  async (_, { rejectWithValue }) => {
    endSessionRequests(); // AUD-40: in-flight requests must not refill the store after the reset
    try {
      await api.post(API_PATHS.AUTH.LOGOUT);
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Logout failed'));
    }
  },
);

/**
 * Register a new CUSTOMER or ANALYST account (ADMIN is seeded only).
 * Phase 4 response: { success, message, data: { id, name, email, role } }
 * The backend REQUIRES `role` ('CUSTOMER' | 'ANALYST') and sets no cookie —
 * the page must navigate to /login on success (AUD-11).
 * @param {{ name: string, email: string, password: string, role: 'CUSTOMER'|'ANALYST' }} payload
 */
export const registerThunk = createAsyncThunk(
  'auth/register',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.AUTH.REGISTER, payload);
      return data.data; // C-P6-14: was data.user (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Registration failed'));
    }
  },
);

/**
 * Change authenticated user's password.
 * @param {{ currentPassword: string, newPassword: string }} payload
 */
export const changePasswordThunk = createAsyncThunk(
  'auth/changePassword',
  async (payload, { rejectWithValue }) => {
    try {
      await api.patch(API_PATHS.AUTH.CHANGE_PASSWORD, payload); // C-P6-34: was api.post — Phase 4 route is PATCH
      endSessionRequests(); // AUD-40: the server ended the session
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Password change failed'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    /** Clear auth error (e.g., on modal close) */
    clearAuthError(state) {
      state.error = null;
    },
    /** Update user fields optimistically (e.g., profile picture upload) */
    updateUser(state, action) {
      state.user = { ...state.user, ...action.payload };
    },
  },
  extraReducers: (builder) => {
    // checkAuth
    builder
      .addCase(checkAuthThunk.pending, (state, action) => {
        state.loading = true;
        state.error   = null;
        state.checkAuthRequestId = action.meta.requestId; // AUD-41
      })
      .addCase(checkAuthThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.checkAuthRequestId) return; // AUD-41: superseded by a login
        state.checkAuthRequestId = null;
        state.loading         = false;
        state.isAuthenticated = true;
        state.user            = action.payload;
      })
      .addCase(checkAuthThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.checkAuthRequestId) return; // AUD-41: superseded by a login
        state.checkAuthRequestId = null;
        state.loading         = false;
        state.isAuthenticated = false;
        state.user            = initialState.user;
      });

    // login
    builder
      .addCase(loginThunk.pending, (state) => {
        state.loading = true;
        state.error   = null;
        state.checkAuthRequestId = null; // AUD-41: a pending session check no longer counts
      })
      .addCase(loginThunk.fulfilled, (state, action) => {
        state.loading         = false;
        state.isAuthenticated = true;
        state.user            = action.payload;
      })
      .addCase(loginThunk.rejected, (state, action) => {
        state.loading = false;
        state.error   = action.payload;
      });

    // logout
    builder
      .addCase(logoutThunk.fulfilled, () => loggedOutState)
      .addCase(logoutThunk.rejected,  () => loggedOutState);

    // register
    builder
      .addCase(registerThunk.pending, (state) => {
        state.loading = true;
        state.error   = null;
      })
      // AUD-11: registration does NOT log the user in — POST /auth/register sets
      // no cookie ("You may now log in."). Marking the user authenticated here
      // sent them to a dashboard whose first API call returned 401.
      .addCase(registerThunk.fulfilled, (state) => {
        state.loading = false;
      })
      .addCase(registerThunk.rejected, (state, action) => {
        state.loading = false;
        state.error   = action.payload;
      });

    // changePassword
    builder
      // AUD-35: does NOT set the global `loading` — ProtectedRoute shows a full-page
      // loader while loading is true, which unmounted the page (and its form) during
      // the request. The page tracks its own submitting state (e.g. RHF isSubmitting).
      .addCase(changePasswordThunk.pending, (state) => {
        state.error = null;
      })
      // The backend clears the session cookie after a password change, so the
      // client must be logged out too (the user signs in with the new password).
      .addCase(changePasswordThunk.fulfilled, () => loggedOutState)
      .addCase(changePasswordThunk.rejected, (state, action) => {
        state.error = action.payload;
      });
  },
});

export const { clearAuthError, updateUser } = authSlice.actions;
export default authSlice.reducer;
