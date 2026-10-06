/**
 * @file src/hooks/useNotifications.js
 * @description Socket.io-client hook for CUSTOMER and ANALYST roles.
 *   - Connects to SOCKET_URL [P9]; listens for 'new-notification'
 *   - Dispatches addLiveNotification to increment unreadCount badge
 *   - Calls toast() to show a visible alert in the corner
 *   - Disconnects on unmount
 *   - ADMIN is excluded per Phase 4 D-P4-09
 * @phase Phase 6 (original) → Phase 9 (SOCKET_URL + connect_error) [P9]
 * @decision D-P6-06, Phase 4 D-P4-09
 */

import { useEffect } from 'react';
import { io } from 'socket.io-client';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';
import { SOCKET_URL } from '../api/apiConfig.js';
import { addLiveNotification } from '../store/slices/notificationSlice.js';

/**
 * Subscribe to real-time notifications for CUSTOMER or ANALYST.
 * Called once in CustomerLayout / AnalystLayout (Phase 7 D-P7-02).
 */
export function useNotifications() {
  const dispatch = useAppDispatch();
  const { user, isAuthenticated } = useAppSelector((s) => s.auth);

  useEffect(() => {
    // ADMIN is excluded from notifications (Phase 4 D-P4-09)
    if (!isAuthenticated || !user?.id || user?.role === 'ADMIN') return;

    const socket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      // Kept for compatibility — the server already joined this room on connect
      socket.emit('join', user.id.toString());
    });

    // [P9] Server middleware rejects handshakes without a valid cookie
    socket.on('connect_error', (err) => {
      if (import.meta.env.DEV) console.warn('[socket] connect_error:', err.message);
    });

    socket.on('new-notification', (payload) => {
      dispatch(addLiveNotification(payload));

      const message = payload?.message ?? 'You have a new notification';
      toast(message, {
        icon: payload?.type === 'FRAUD_ALERT' ? '🚨' : '🔔',
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, user?.id, user?.role, dispatch]);
}
