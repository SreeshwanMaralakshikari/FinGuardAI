/**
 * @file src/store/index.js
 * @description Redux store configuration using RTK v2 configureStore.
 *   - Combines all 7 slices: auth, transactions, fraudAlerts,
 *     fraudCases, notifications, analytics, simulation
 *   - Exports typed store, RootState, and AppDispatch
 *   - AUD-30: ending a session (logout, or a password change, which the server
 *     also ends) resets EVERY slice. Before, only `auth` was reset, so the next
 *     person on the same browser tab briefly saw the previous user's
 *     transactions, notifications and unread badge.
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-14
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit';

import authReducer, { logoutThunk, changePasswordThunk } from './slices/authSlice.js';
import transactionReducer  from './slices/transactionSlice.js';
import fraudAlertReducer   from './slices/fraudAlertSlice.js';
import fraudCaseReducer    from './slices/fraudCaseSlice.js';
import notificationReducer from './slices/notificationSlice.js';
import analyticsReducer    from './slices/analyticsSlice.js';
import simulationReducer   from './slices/simulationSlice.js';

const appReducer = combineReducers({
  auth:          authReducer,
  transactions:  transactionReducer,
  fraudAlerts:   fraudAlertReducer,
  fraudCases:    fraudCaseReducer,
  notifications: notificationReducer,
  analytics:     analyticsReducer,
  simulation:    simulationReducer,
});

/** Actions after which no user data may remain in memory (AUD-30). */
const SESSION_END_ACTIONS = new Set([
  logoutThunk.fulfilled.type,
  logoutThunk.rejected.type,
  changePasswordThunk.fulfilled.type,
]);

/**
 * Passing `undefined` makes every slice return its initialState; the auth
 * slice then handles the same action and ends in its logged-out state.
 */
export const rootReducer = (state, action) =>
  appReducer(SESSION_END_ACTIONS.has(action.type) ? undefined : state, action);

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Socket.io event objects may contain non-serializable data
        ignoredActions: ['simulation/addSimulationEvent'],
      },
    }),
  devTools: import.meta.env.DEV,
});

/** @typedef {ReturnType<typeof store.getState>} RootState */
/** @typedef {typeof store.dispatch} AppDispatch */
