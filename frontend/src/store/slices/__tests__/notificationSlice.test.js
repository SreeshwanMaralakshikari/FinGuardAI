// src/store/slices/__tests__/notificationSlice.test.js
import { it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import notificationReducer, { addLiveNotification, markNotificationReadThunk, fetchUnreadCountThunk } from '../notificationSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), patch: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = () => configureStore({ reducer: { notifications: notificationReducer } });

it('AUD-08: a live notification carrying only `id` can be marked read', async () => {
  const store = makeStore();
  store.dispatch(addLiveNotification({ id: 'n1', type: 'FRAUD_ALERT', message: 'x', isRead: false }));
  expect(store.getState().notifications).toMatchObject({ unreadCount: 1 });
  api.patch.mockResolvedValueOnce({ data: { success: true } });
  await store.dispatch(markNotificationReadThunk('n1'));
  expect(api.patch).toHaveBeenCalledWith('/notification-api/notifications/n1/read');
  expect(store.getState().notifications).toMatchObject({ unreadCount: 0 });
  expect(store.getState().notifications.notifications[0].isRead).toBe(true);
});

it('fetchUnreadCountThunk reads data.data.unreadCount (C-P6-27)', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: { unreadCount: 4 } } });
  const store = makeStore();
  await store.dispatch(fetchUnreadCountThunk());
  expect(store.getState().notifications.unreadCount).toBe(4);
});
