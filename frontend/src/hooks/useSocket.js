/**
 * @file src/hooks/useSocket.js
 * @description Socket.io-client hook for Admin role.
 *   - Connects to SOCKET_URL [P9] on mount; the server authenticates the
 *     handshake with the HTTP-only cookie and joins the user's room itself
 *   - Listens for: 'fraud_alert', 'simulation_start', 'simulation_stop'
 *   - Dispatches to appropriate Redux slices
 *   - Disconnects on unmount (cleanup)
 *   - ADMIN only: useNotifications.js handles CUSTOMER/ANALYST
 *   - F-08: a live 'fraud_alert' also schedules ONE debounced analytics refresh, so the dashboard
 *     KPIs follow the feed (a burst of alerts → one request).
 *   - F-01: an auth rejection stops the reconnect loop and re-runs the session check; after a
 *     reconnect the analytics are refreshed (alerts were missed while offline).
 *   - F-04: socket.io-client is imported lazily (api/socketClient.js).
 * @phase Phase 6 (original) → Phase 9 (SOCKET_URL + connect_error) [P9]
 * @decision D-P6-05, D-P6-13
 */

import { useEffect } from 'react';
import { useStore } from 'react-redux';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';
import { openSocket, isSocketAuthError, handleSocketAuthError } from '../api/socketClient.js';
import { addLiveFraudAlert }   from '../store/slices/fraudAlertSlice.js';
import { fetchAnalyticsThunk } from '../store/slices/analyticsSlice.js';
import { startSimulationLive, stopSimulationLive, addSimulationEvent } from '../store/slices/simulationSlice.js';

/** F-08: wait this long after the last live alert before refreshing the KPIs. */
export const ANALYTICS_REFRESH_DEBOUNCE_MS = 3_000;

/**
 * Connect to socket and register Admin-level event listeners.
 * Called once in AdminLayout (Phase 7 D-P7-02).
 */
export function useSocket() {
  const dispatch = useAppDispatch();
  const store = useStore();
  const { user, isAuthenticated } = useAppSelector((s) => s.auth);

  useEffect(() => {
    // Only connect when Admin is authenticated
    if (!isAuthenticated || user?.role !== 'ADMIN') return undefined;

    let cancelled = false;
    let socket = null;
    let connects = 0;
    let refreshTimer = null;

    const scheduleAnalyticsRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!store.getState().analytics?.loading) dispatch(fetchAnalyticsThunk());
      }, ANALYTICS_REFRESH_DEBOUNCE_MS);
    };

    openSocket().then((s) => {
      if (cancelled) { s.disconnect(); return; }
      socket = s;

      // Kept for compatibility — the server already joined this room on connect
      s.on('connect', () => {
        connects += 1;
        if (user?.id) s.emit('join', user.id.toString());
        if (connects > 1) scheduleAnalyticsRefresh(); // F-01: alerts were missed while offline
      });

      // [P9] Server middleware rejects handshakes without a valid cookie
      s.on('connect_error', (err) => {
        if (isSocketAuthError(err)) { // F-01: session over — stop retrying
          handleSocketAuthError(s, dispatch);
          return;
        }
        if (import.meta.env.DEV) console.warn('[socket] connect_error:', err.message);
      });

      s.on('fraud_alert', (payload) => {
        dispatch(addLiveFraudAlert(payload));
        // FE-fix: the simulation feed is only for simulation runs, not every real alert
        if (store.getState().simulation.isRunning) dispatch(addSimulationEvent(payload));
        scheduleAnalyticsRefresh(); // F-08
      });

      s.on('simulation_start', (payload) => {
        dispatch(startSimulationLive(payload));
      });

      s.on('simulation_stop', (payload) => {
        dispatch(stopSimulationLive(payload));
      });
    }).catch((err) => {
      // The chunk could not be loaded (offline): live updates are unavailable, the REST pages still work
      if (import.meta.env.DEV) console.warn('[socket] could not load socket.io-client:', err?.message);
    });

    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      socket?.disconnect();
    };
  }, [isAuthenticated, user?.id, user?.role, dispatch, store]);
}
