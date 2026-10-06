// src/store/slices/__tests__/fraudAlertSlice.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import fraudAlertReducer, {
  fetchFraudAlertsThunk, fetchFlaggedTransactionsThunk, fetchFlaggedTransactionByIdThunk, addLiveFraudAlert,
} from '../fraudAlertSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = () => configureStore({ reducer: { fraudAlerts: fraudAlertReducer } });
beforeEach(() => vi.clearAllMocks());

describe('customer alerts', () => {
  it('fetchFraudAlertsThunk calls /customer-api/fraud-alerts and stores the list', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: [{ _id: 'a1', riskLevel: 'HIGH', status: 'OPEN' }], pagination: { total: 1, page: 1, limit: 10 } } });
    const store = makeStore();
    await store.dispatch(fetchFraudAlertsThunk({ page: 1 }));
    expect(api.get).toHaveBeenCalledWith('/customer-api/fraud-alerts', { params: { page: 1 } });
    expect(store.getState().fraudAlerts.alerts[0].riskLevel).toBe('HIGH');
  });
  it('addLiveFraudAlert prepends and bumps the total', () => {
    const store = makeStore();
    store.dispatch(addLiveFraudAlert({ publicId: 'TXN-1' }));
    expect(store.getState().fraudAlerts.pagination.total).toBe(1);
  });
});

describe('analyst flagged transactions (AUD-13)', () => {
  it('fetchFlaggedTransactionsThunk calls the ANALYST endpoint', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: [{ _id: 't1', riskLevel: 'CRITICAL' }], pagination: { total: 1, page: 1, limit: 20 } } });
    const store = makeStore();
    await store.dispatch(fetchFlaggedTransactionsThunk({ riskLevel: 'CRITICAL' }));
    expect(api.get).toHaveBeenCalledWith('/analyst-api/flagged-transactions', { params: { riskLevel: 'CRITICAL' } });
    expect(store.getState().fraudAlerts.flagged).toMatchObject({ items: [{ _id: 't1', riskLevel: 'CRITICAL' }], pagination: { total: 1, limit: 20 } });
  });
  it('fetchFlaggedTransactionByIdThunk stores the investigation context incl. fraudAlert._id', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: { transaction: { _id: 't1' }, deviceReputation: null, fraudAlert: { _id: 'fa1' }, existingCase: null } } });
    const store = makeStore();
    await store.dispatch(fetchFlaggedTransactionByIdThunk('t1'));
    expect(api.get).toHaveBeenCalledWith('/analyst-api/flagged-transactions/t1');
    expect(store.getState().fraudAlerts.selectedFlagged.fraudAlert._id).toBe('fa1');
  });
});
