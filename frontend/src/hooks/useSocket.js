/**
 * @file src/hooks/useSocket.js
 * @description Socket.io-client hook for Admin role.
 *   - Connects to SOCKET_URL [P9] on mount; the server authenticates the
 *     handshake with the HTTP-only cookie and joins the user's room itself
 *   - Listens for: 'fraud_alert', 'simulation_start', 'simulation_stop', 'new-notification'
 *   - Dispatches to appropriate Redux slices
 *   - Disconnects on unmount (cleanup)
 *   - ADMIN only: useNotifications.js handles CUSTOMER/ANALYST
 * @phase Phase 6 (original) → Phase 9 (SOCKET_URL + connect_error) [P9]
 * @decision D-P6-05, D-P6-13
 */

import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useStore } from 'react-redux';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';
import { SOCKET_URL } from '../api/apiConfig.js';
import { addLiveFraudAlert }   from '../store/slices/fraudAlertSlice.js';
import { startSimulationLive, stopSimulationLive, addSimulationEvent } from '../store/slices/simulationSlice.js';

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
    if (!isAuthenticated || user?.role !== 'ADMIN') return;

    const socket = io(SOCKET_URL, {
      withCredentials: true,     // send the auth cookie on the handshake
      transports: ['websocket'], // D-P6-13
    });

    // Kept for compatibility — the server already joined this room on connect
    socket.on('connect', () => {
      if (user?.id) socket.emit('join', user.id.toString());
    });

    // [P9] Server middleware rejects handshakes without a valid cookie
    socket.on('connect_error', (err) => {
      if (import.meta.env.DEV) console.warn('[socket] connect_error:', err.message);
    });

    socket.on('fraud_alert', (payload) => {
      dispatch(addLiveFraudAlert(payload));
      // FE-fix: the simulation feed is only for simulation runs, not every real alert
      if (store.getState().simulation.isRunning) dispatch(addSimulationEvent(payload));
    });

    socket.on('simulation_start', (payload) => {
      dispatch(startSimulationLive(payload));
    });

    socket.on('simulation_stop', (payload) => {
      dispatch(stopSimulationLive(payload));
    });

    socket.on('new-notification', (_payload) => {
      // No-op for ADMIN — D-P4-09: ADMIN excluded from notifications
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, user?.id, user?.role, dispatch, store]);
}
