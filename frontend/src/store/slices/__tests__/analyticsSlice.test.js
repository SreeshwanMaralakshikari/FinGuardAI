// src/store/slices/__tests__/analyticsSlice.test.js
import { it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import analyticsReducer, { fetchAnalyticsThunk, fetchLossStatsThunk } from '../analyticsSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = () => configureStore({ reducer: { analytics: analyticsReducer } });

it('maps GET /admin-api/analytics (fraudByPaymentMethod → fraudByDevice, D-P6-11; lossPrevented, C-P6-11)', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: {
    fraudByHour: [{ hour: 8, count: 2 }], fraudByPaymentMethod: [{ paymentMethod: 'UPI', count: 2 }],
    fraudByLocation: [{ city: 'Mumbai', count: 1 }], riskDistribution: [{ _id: 'HIGH', count: 2 }], lossPrevented: 42000,
  } } });
  const store = makeStore();
  await store.dispatch(fetchAnalyticsThunk());
  expect(api.get).toHaveBeenCalledWith('/admin-api/analytics');
  expect(store.getState().analytics).toMatchObject({
    loading: false, fraudByHour: [{ hour: 8, count: 2 }], fraudByDevice: [{ paymentMethod: 'UPI', count: 2 }], lossPrevented: 42000,
  });
});

it('defaults missing arrays and lossPrevented to empty / 0', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
  const store = makeStore();
  await store.dispatch(fetchAnalyticsThunk());
  expect(store.getState().analytics).toMatchObject({ fraudByHour: [], fraudByDevice: [], lossPrevented: 0 });
});

it('stores trends from GET /admin-api/analytics/trends (D-P6-12)', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: { dailyTrend: [{ date: '2026-09-23', count: 1 }], peakFraudHours: [] } } });
  const store = makeStore();
  await store.dispatch(fetchLossStatsThunk());
  expect(api.get).toHaveBeenCalledWith('/admin-api/analytics/trends');
  expect(store.getState().analytics.lossStats.dailyTrend).toHaveLength(1);
});
