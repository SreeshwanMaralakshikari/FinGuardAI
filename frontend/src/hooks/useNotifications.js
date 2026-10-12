/**
 * @file src/hooks/useNotifications.js
 * @description Socket.io-client hook for CUSTOMER and ANALYST roles.
 *   - Connects to SOCKET_URL [P9]; listens for 'new-notification'
 *   - Dispatches addLiveNotification to increment unreadCount badge
 *   - Calls toast() to show a visible alert in the corner
 *   - Disconnects on unmount
 *   - ADMIN is excluded per Phase 4 D-P4-09
 *   - F-01: on the 2nd and later 'connect' (Render restart, network blip) the unread badge — and the
 *     list, when the panel is open — are refetched, because pushes were missed while offline.
 *     An auth rejection (expired JWT) stops the reconnect loop and re-runs the session check.
 *   - F-04: socket.io-client is imported lazily (api/socketClient.js).
 * @phase Phase 6 (original) → Phase 9 (SOCKET_URL + connect_error) [P9]
 * @decision D-P6-06, Phase 4 D-P4-09
 */

import { useEffect } from 'react';
import { useStore } from 'react-redux';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';
import { openSocket, isSocketAuthError, handleSocketAuthError } from '../api/socketClient.js';
import {
  addLiveNotification, fetchUnreadCountThunk, fetchNotificationsThunk,
} from '../store/slices/notificationSlice.js';
import { PAGINATION } from '../utils/constants.js';

/**
 * Subscribe to real-time notifications for CUSTOMER or ANALYST.
 * Called once in CustomerLayout / AnalystLayout (Phase 7 D-P7-02).
 */
export function useNotifications() {
  const dispatch = useAppDispatch();
  const store = useStore();
  const { user, isAuthenticated } = useAppSelector((s) => s.auth);

  useEffect(() => {
    // ADMIN is excluded from notifications (Phase 4 D-P4-09)
    if (!isAuthenticated || !user?.id || user?.role === 'ADMIN') return undefined;

    let cancelled = false;
    let socket = null;
    let connects = 0;

    openSocket().then((s) => {
      if (cancelled) { s.disconnect(); return; }
      socket = s;

      s.on('connect', () => {
        connects += 1;
        // Kept for compatibility — the server already joined this room on connect
        s.emit('join', user.id.toString());
        if (connects > 1) {
          // F-01: reconnected — whatever was pushed meanwhile was missed
          dispatch(fetchUnreadCountThunk());
          if (store.getState().notifications?.panelOpen) {
            dispatch(fetchNotificationsThunk({ limit: PAGINATION.DEFAULT_LIMIT_CASES }));
          }
        }
      });

      // [P9] Server middleware rejects handshakes without a valid cookie
      s.on('connect_error', (err) => {
        if (isSocketAuthError(err)) { // F-01: session over — stop retrying
          handleSocketAuthError(s, dispatch);
          return;
        }
        if (import.meta.env.DEV) console.warn('[socket] connect_error:', err.message);
      });

      s.on('new-notification', (payload) => {
        dispatch(addLiveNotification(payload));

        const message = payload?.message ?? 'You have a new notification';
        toast(message, {
          icon: payload?.type === 'FRAUD_ALERT' ? '🚨' : '🔔',
        });
      });
    }).catch((err) => {
      // The chunk could not be loaded (offline): live updates are unavailable, the REST pages still work
      if (import.meta.env.DEV) console.warn('[socket] could not load socket.io-client:', err?.message);
    });

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [isAuthenticated, user?.id, user?.role, dispatch, store]);
}
