/**
 * @file src/store/slices/notificationSlice.js
 * @description Redux slice for user notification state (CUSTOMER + ANALYST only).
 *   State: { notifications[], unreadCount, loading, error, listRequestId }
 *   N-02 / N-03: a failed list fetch is kept in `error` (cleared on pending); only the latest
 *   list request may write its result.
 *   Live action: addLiveNotification (dispatched by useNotifications on 'new-notification' event)
 *
 *   Response unwrapping (D-P6-23, C-P6-26..C-P6-27):
 *     List:   { success, data: [...notifications], pagination: {...} }
 *             NOTE: list endpoint does NOT return unreadCount — fetch separately
 *     Count:  { success, data: { unreadCount } }
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-06, Phase 4 D-P4-09, Phase 4 D-P4-13, D-P6-23
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage, rejectedMessage } from '../../api/errors.js'; // AUD-32

const initialState = {
  notifications: [],
  unreadCount:   0,
  loading:       false,
  error:         '',
  listRequestId: null,
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/**
 * Fetch paginated notifications for the authenticated user.
 * Phase 4 response: { success, data: [...notifications], pagination: {...} }
 * NOTE: list endpoint does NOT include unreadCount — use fetchUnreadCountThunk separately.
 */
export const fetchNotificationsThunk = createAsyncThunk(
  'notifications/fetchAll',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.NOTIFICATIONS.LIST, { params });
      // C-P6-26: was `return data` — reducer read action.payload.notifications (undefined)
      // Also removed unreadCount from this response (not present in list endpoint)
      return { notifications: data.data };
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch notifications'));
    }
  },
);

/**
 * Fetch unread notification count.
 * Phase 4 response: { success, data: { unreadCount } }
 */
export const fetchUnreadCountThunk = createAsyncThunk(
  'notifications/fetchUnreadCount',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.NOTIFICATIONS.UNREAD_COUNT);
      return data.data.unreadCount; // C-P6-27: was data.unreadCount (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch unread count'));
    }
  },
);

/** @param {string} id */
export const markNotificationReadThunk = createAsyncThunk(
  'notifications/markRead',
  async (id, { rejectWithValue }) => {
    try {
      await api.patch(`${API_PATHS.NOTIFICATIONS.MARK_READ}/${id}/read`); // C-P6-03
      return id;
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to mark as read'));
    }
  },
);

export const markAllReadThunk = createAsyncThunk(
  'notifications/markAllRead',
  async (_, { rejectWithValue }) => {
    try {
      await api.patch(API_PATHS.NOTIFICATIONS.MARK_ALL_READ);
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to mark all as read'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const notificationSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    /**
     * Prepend a live notification received via Socket.io 'new-notification' event.
     * Dispatched by useNotifications.js for CUSTOMER and ANALYST roles.
     * @param {Object} action.payload - Notification object from socket event
     */
    addLiveNotification(state, action) {
      // AUD-08: socket payloads historically carried `id`; list items use `_id`
      // (markNotificationReadThunk matches on _id). Normalise to _id.
      const payload = action.payload ?? {};
      state.notifications.unshift({ ...payload, _id: payload._id ?? payload.id });
      state.unreadCount += 1;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotificationsThunk.pending, (state, action) => {
        state.loading       = true;
        state.error         = '';
        state.listRequestId = action.meta.requestId;
      })
      .addCase(fetchNotificationsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return; // N-03: stale answer
        state.listRequestId = null;
        state.loading       = false;
        state.notifications = action.payload.notifications;
        // unreadCount NOT set here — not included in list response (C-P6-26)
        // Use fetchUnreadCountThunk to populate unreadCount
      })
      .addCase(fetchNotificationsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return;
        state.listRequestId = null;
        state.loading       = false;
        state.error         = rejectedMessage(action, 'Failed to fetch notifications');
      });

    builder
      .addCase(fetchUnreadCountThunk.fulfilled, (state, action) => {
        state.unreadCount = action.payload; // C-P6-27: now correctly data.data.unreadCount
      });

    builder
      .addCase(markNotificationReadThunk.fulfilled, (state, action) => {
        const notif = state.notifications.find((n) => n._id === action.payload);
        if (notif && !notif.isRead) {
          notif.isRead      = true;
          state.unreadCount = Math.max(0, state.unreadCount - 1);
        }
      });

    builder
      .addCase(markAllReadThunk.fulfilled, (state) => {
        state.notifications.forEach((n) => { n.isRead = true; });
        state.unreadCount = 0;
      });
  },
});

export const { addLiveNotification } = notificationSlice.actions;
export default notificationSlice.reducer;
