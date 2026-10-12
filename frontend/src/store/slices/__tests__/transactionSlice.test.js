// src/store/slices/__tests__/transactionSlice.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import transactionReducer, { fetchTransactionsThunk, submitTransactionThunk, fetchTransactionByIdThunk } from '../transactionSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
import api from '../../../api/axios.js';

const makeStore = () => configureStore({ reducer: { transactions: transactionReducer } });
beforeEach(() => vi.clearAllMocks());

describe('fetchTransactionsThunk', () => {
  it('stores the list and pagination (Phase 4: data is an array, pagination separate)', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: [{ _id: 't1', publicId: 'TXN-2026-00001' }], pagination: { total: 1, page: 1, limit: 10, pages: 1 } } });
    const store = makeStore();
    await store.dispatch(fetchTransactionsThunk({ page: 1 }));
    const s = store.getState().transactions;
    expect(s.transactions).toHaveLength(1);
    expect(s.pagination).toMatchObject({ total: 1, page: 1, limit: 10 });
    expect(s.loading).toBe(false);
  });
  it('clears loading on failure and keeps the previous list', async () => {
    api.get.mockRejectedValueOnce({ response: { data: { message: 'Unauthorized' } } });
    const store = makeStore();
    await store.dispatch(fetchTransactionsThunk());
    expect(store.getState().transactions).toMatchObject({ loading: false, transactions: [] });
  });
});

describe('submitTransactionThunk (flat response, C-P6-33)', () => {
  it('prepends the flat transaction summary', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 't2', publicId: 'TXN-2026-00002', riskLevel: 'LOW', status: 'APPROVED' } } });
    const store = makeStore();
    await store.dispatch(submitTransactionThunk({ amount: 500 }));
    expect(store.getState().transactions.transactions[0].publicId).toBe('TXN-2026-00002');
  });
});

describe('fetchTransactionByIdThunk (composite, C-P6-32)', () => {
  it('stores { transaction, deviceReputation }', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: { transaction: { publicId: 'TXN-2026-00003' }, deviceReputation: null } } });
    const store = makeStore();
    await store.dispatch(fetchTransactionByIdThunk('t3'));
    expect(api.get).toHaveBeenCalledWith('/customer-api/transactions/t3');
    expect(store.getState().transactions.selectedTransaction.transaction.publicId).toBe('TXN-2026-00003');
  });
});

describe('submitTransactionThunk idempotency (C-01)', () => {
  it('sends the key as the Idempotency-Key header and keeps it out of the body', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 't1' } } });
    const store = configureStore({ reducer: { transactions: transactionReducer } });
    await store.dispatch(submitTransactionThunk({ amount: 5, idempotencyKey: 'key-123' }));
    expect(api.post).toHaveBeenCalledWith('/customer-api/transactions', { amount: 5 }, { headers: { 'Idempotency-Key': 'key-123' } });
  });

  it('without a key the call is exactly as before (no third argument)', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: 't1' } } });
    const store = configureStore({ reducer: { transactions: transactionReducer } });
    await store.dispatch(submitTransactionThunk({ amount: 5 }));
    expect(api.post.mock.calls.at(-1)).toEqual(['/customer-api/transactions', { amount: 5 }]);
  });

  it('a rejection with a response is a normal failure; without one it is flagged meta.noResponse', async () => {
    const store = configureStore({ reducer: { transactions: transactionReducer } });
    api.post.mockRejectedValueOnce({ response: { status: 500, data: { message: 'boom' } } });
    const withResponse = await store.dispatch(submitTransactionThunk({ amount: 5 }));
    expect(withResponse.payload).toBe('boom');
    expect(withResponse.meta.noResponse).toBe(false);

    api.post.mockRejectedValueOnce(Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' }));
    const noResponse = await store.dispatch(submitTransactionThunk({ amount: 5 }));
    expect(noResponse.meta.noResponse).toBe(true);
  });
});
