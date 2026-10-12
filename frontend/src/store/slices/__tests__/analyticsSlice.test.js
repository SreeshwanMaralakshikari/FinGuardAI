// src/store/slices/__tests__/analyticsSlice.test.js
import { it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import analyticsReducer, { fetchAnalyticsThunk, fetchLossStatsThunk } from '../analyticsSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = () => configureStore({ reducer: { analytics: analyticsReducer } });

it('maps GET /admin-api/analytics (fraudByPaymentMethod, D-P6-11; lossPrevented, C-P6-11)', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: {
    fraudByHour: [{ hour: 8, count: 2 }], fraudByPaymentMethod: [{ paymentMethod: 'UPI', count: 2 }],
    fraudByDevice: [{ deviceId: 'dev-1', count: 3, userCount: 2 }], scoreHistogram: [{ from: 0, to: 9, label: '0-9', count: 4 }],
    fraudByLocation: [{ city: 'Mumbai', count: 1 }], riskDistribution: [{ _id: 'HIGH', count: 2 }], lossPrevented: 42000,
  } } });
  const store = makeStore();
  await store.dispatch(fetchAnalyticsThunk());
  expect(api.get).toHaveBeenCalledWith('/admin-api/analytics');
  expect(store.getState().analytics).toMatchObject({
    loading: false, fraudByHour: [{ hour: 8, count: 2 }], fraudByPaymentMethod: [{ paymentMethod: 'UPI', count: 2 }],
    fraudByDevice: [{ deviceId: 'dev-1', count: 3, userCount: 2 }], scoreHistogram: [{ from: 0, to: 9, label: '0-9', count: 4 }], lossPrevented: 42000,
  });
});

it('defaults missing arrays and lossPrevented to empty / 0', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
  const store = makeStore();
  await store.dispatch(fetchAnalyticsThunk());
  expect(store.getState().analytics).toMatchObject({ fraudByHour: [], fraudByPaymentMethod: [], fraudByDevice: [], scoreHistogram: [], lossPrevented: 0 });
});

it('stores trends from GET /admin-api/analytics/trends (D-P6-12)', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: { dailyTrend: [{ date: '2026-09-23', count: 1 }], peakFraudHours: [] } } });
  const store = makeStore();
  await store.dispatch(fetchLossStatsThunk());
  expect(api.get).toHaveBeenCalledWith('/admin-api/analytics/trends');
  expect(store.getState().analytics.lossStats.dailyTrend).toHaveLength(1);
});

it('A-01: sends the date range as query params and keeps the real device list apart from the payment methods', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: { fraudByPaymentMethod: [{ paymentMethod: 'UPI', count: 1 }] } } });
  const store = makeStore();
  const range = { startDate: '2026-10-01T00:00:00.000+05:30', endDate: '2026-10-05T23:59:59.999+05:30' };
  await store.dispatch(fetchAnalyticsThunk(range));
  expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics', { params: range });
  expect(store.getState().analytics.fraudByDevice).toEqual([]);
  expect(store.getState().analytics.fraudByPaymentMethod).toEqual([{ paymentMethod: 'UPI', count: 1 }]);
});

it('A-01: a refresh without arguments keeps the date range of the last explicit fetch', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: {} } });
  const store = makeStore();
  const range = { startDate: '2026-10-01T00:00:00.000+05:30' };
  await store.dispatch(fetchAnalyticsThunk(range));
  await store.dispatch(fetchAnalyticsThunk()); // e.g. the socket refresh
  expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics', { params: range });
  await store.dispatch(fetchAnalyticsThunk({})); // Clear
  expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics');
});
