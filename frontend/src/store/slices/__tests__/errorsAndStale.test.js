// N-02 / N-03 / N-20: every list / detail slice keeps its fetch error, tracks loading per thunk
// and ignores answers of superseded requests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../../api/axios.js';
import transactions, {
  fetchTransactionsThunk, fetchTransactionByIdThunk, submitTransactionThunk, clearSelectedTransaction,
} from '../transactionSlice.js';
import fraudAlerts, {
  fetchFraudAlertsThunk, fetchFraudAlertByIdThunk, fetchFlaggedTransactionsThunk,
  fetchFlaggedTransactionByIdThunk, clearSelectedFlagged, clearSelectedAlert, addLiveFraudAlert,
} from '../fraudAlertSlice.js';
import fraudCases, {
  fetchCasesThunk, fetchCaseByIdThunk, addCaseNoteThunk, assignCaseThunk, clearSelectedCase,
} from '../fraudCaseSlice.js';
import notifications, { fetchNotificationsThunk } from '../notificationSlice.js';
import analytics, { fetchAnalyticsThunk, fetchLossStatsThunk } from '../analyticsSlice.js';
import auth from '../authSlice.js';

/** A request the test settles by hand. */
function pendingRequest() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const list = (rows, total = rows.length) => ({ data: { success: true, data: rows, pagination: { total, page: 1, limit: 10 } } });
const err = (message, status = 500) => ({ response: { status, data: { success: false, message } } });
const storeOf = (slices) => configureStore({ reducer: slices });

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); api.patch.mockReset();
});

describe('transactions', () => {
  const make = () => storeOf({ transactions });

  it('keeps the list error, clears it on the next request, and keeps `loading` per request', async () => {
    const store = make();
    api.get.mockRejectedValueOnce(err('Server exploded'));
    await store.dispatch(fetchTransactionsThunk());
    expect(store.getState().transactions).toMatchObject({ loading: false, error: 'Server exploded', transactions: [] });

    const second = pendingRequest();
    api.get.mockReturnValueOnce(second.promise);
    const p = store.dispatch(fetchTransactionsThunk());
    expect(store.getState().transactions).toMatchObject({ loading: true, error: '' }); // cleared on pending
    second.resolve(list([{ _id: 't1' }]));
    await p;
    expect(store.getState().transactions).toMatchObject({ loading: false, error: '' });
  });

  it('a superseded list response is ignored (out-of-order answers)', async () => {
    const store = make();
    const high = pendingRequest(); const low = pendingRequest();
    api.get.mockReturnValueOnce(high.promise).mockReturnValueOnce(low.promise);
    const pHigh = store.dispatch(fetchTransactionsThunk({ riskLevel: 'HIGH' }));
    const pLow = store.dispatch(fetchTransactionsThunk({ riskLevel: 'LOW' }));
    low.resolve(list([{ _id: 'low' }]));
    await pLow;
    high.resolve(list([{ _id: 'high' }]));
    await pHigh;
    expect(store.getState().transactions.transactions.map((t) => t._id)).toEqual(['low']);
    expect(store.getState().transactions.loading).toBe(false);
  });

  it('a superseded FAILURE does not show an error for the newer request', async () => {
    const store = make();
    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchTransactionsThunk({ page: 1 }));
    const pB = store.dispatch(fetchTransactionsThunk({ page: 2 }));
    b.resolve(list([{ _id: 'b' }]));
    await pB;
    a.reject(err('old failure'));
    await pA;
    expect(store.getState().transactions).toMatchObject({ error: '', transactions: [{ _id: 'b' }] });
  });

  it('detail: A then B quickly → only B is shown; own loading flag; error kept', async () => {
    const store = make();
    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchTransactionByIdThunk('A'));
    const pB = store.dispatch(fetchTransactionByIdThunk('B'));
    expect(store.getState().transactions).toMatchObject({ detailLoading: true, loading: false });
    b.resolve({ data: { data: { transaction: { _id: 'B' } } } });
    await pB;
    a.resolve({ data: { data: { transaction: { _id: 'A' } } } });
    await pA;
    expect(store.getState().transactions.selectedTransaction.transaction._id).toBe('B');

    api.get.mockRejectedValueOnce(err('Transaction not found', 404));
    await store.dispatch(fetchTransactionByIdThunk('C'));
    expect(store.getState().transactions).toMatchObject({ detailError: 'Transaction not found', detailLoading: false, selectedTransaction: null });
  });

  it('a late detail response after the modal was closed does not repopulate it', async () => {
    const store = make();
    const d = pendingRequest();
    api.get.mockReturnValueOnce(d.promise);
    const p = store.dispatch(fetchTransactionByIdThunk('A'));
    store.dispatch(clearSelectedTransaction());
    d.resolve({ data: { data: { transaction: { _id: 'A' } } } });
    await p;
    expect(store.getState().transactions).toMatchObject({ selectedTransaction: null, detailLoading: false, detailError: '' });
  });

  it('submit uses its own flag and does not touch the list loading flag', async () => {
    const store = make();
    const s = pendingRequest();
    api.post.mockReturnValueOnce(s.promise);
    const p = store.dispatch(submitTransactionThunk({ amount: 1 }));
    expect(store.getState().transactions).toMatchObject({ submitting: true, loading: false });
    s.resolve({ data: { data: { id: 'x', publicId: 'TXN-1' } } });
    await p;
    expect(store.getState().transactions.submitting).toBe(false);
  });
});

describe('fraudAlerts', () => {
  const make = () => storeOf({ fraudAlerts });

  it('each of the four fetch thunks has its own loading flag and error', async () => {
    const store = make();
    const reqs = [pendingRequest(), pendingRequest(), pendingRequest(), pendingRequest()];
    reqs.forEach((r) => api.get.mockReturnValueOnce(r.promise));
    const ps = [
      store.dispatch(fetchFraudAlertsThunk()),
      store.dispatch(fetchFraudAlertByIdThunk('a')),
      store.dispatch(fetchFlaggedTransactionsThunk()),
      store.dispatch(fetchFlaggedTransactionByIdThunk('t')),
    ];
    expect(store.getState().fraudAlerts).toMatchObject({ loading: true, detailLoading: true, flaggedLoading: true, flaggedDetailLoading: true });

    reqs[0].resolve(list([{ _id: 'a1' }]));
    await ps[0];
    expect(store.getState().fraudAlerts).toMatchObject({ loading: false, detailLoading: true, flaggedLoading: true, flaggedDetailLoading: true });

    reqs[2].reject(err('flagged failed'));
    await ps[2];
    expect(store.getState().fraudAlerts).toMatchObject({ flaggedLoading: false, flaggedError: 'flagged failed', error: '' });

    reqs[1].reject(err('no alert', 404)); reqs[3].reject(err('no tx', 404));
    await Promise.all([ps[1], ps[3]]);
    expect(store.getState().fraudAlerts).toMatchObject({ detailError: 'no alert', flaggedDetailError: 'no tx', detailLoading: false, flaggedDetailLoading: false });
  });

  it('customer list: an error is kept and cleared by the next request', async () => {
    const store = make();
    api.get.mockRejectedValueOnce(err('Too many requests', 429));
    await store.dispatch(fetchFraudAlertsThunk());
    expect(store.getState().fraudAlerts).toMatchObject({ error: 'Too many requests', alerts: [] });
    api.get.mockResolvedValueOnce(list([]));
    await store.dispatch(fetchFraudAlertsThunk());
    expect(store.getState().fraudAlerts.error).toBe('');
  });

  it('flagged list: out-of-order answers keep the latest request', async () => {
    const store = make();
    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchFlaggedTransactionsThunk({ riskLevel: 'HIGH' }));
    const pB = store.dispatch(fetchFlaggedTransactionsThunk({ riskLevel: 'CRITICAL' }));
    b.resolve(list([{ _id: 'crit' }]));
    await pB;
    a.resolve(list([{ _id: 'high' }]));
    await pA;
    expect(store.getState().fraudAlerts.flagged.items).toEqual([{ _id: 'crit' }]);
  });

  it('flagged detail: a late answer after clearSelectedFlagged is dropped', async () => {
    const store = make();
    const d = pendingRequest();
    api.get.mockReturnValueOnce(d.promise);
    const p = store.dispatch(fetchFlaggedTransactionByIdThunk('t1'));
    store.dispatch(clearSelectedFlagged());
    d.resolve({ data: { data: { transaction: { _id: 't1' } } } });
    await p;
    expect(store.getState().fraudAlerts).toMatchObject({ selectedFlagged: null, flaggedDetailLoading: false });
  });

  it('alert detail: a late answer after clearSelectedAlert is dropped', async () => {
    const store = make();
    const d = pendingRequest();
    api.get.mockReturnValueOnce(d.promise);
    const p = store.dispatch(fetchFraudAlertByIdThunk('a1'));
    store.dispatch(clearSelectedAlert());
    d.resolve({ data: { data: { _id: 'a1' } } });
    await p;
    expect(store.getState().fraudAlerts.selectedAlert).toBeNull();
  });

  it('N-20: live alerts are capped at 100 (newest kept)', () => {
    const store = make();
    for (let i = 0; i < 130; i += 1) store.dispatch(addLiveFraudAlert({ transactionId: `t${i}` }));
    const { alerts, pagination } = store.getState().fraudAlerts;
    expect(alerts).toHaveLength(100);
    expect(alerts[0]._id).toBe('t129');
    expect(alerts.at(-1)._id).toBe('t30');
    expect(pagination.total).toBe(130);
  });
});

describe('fraudCases', () => {
  const make = (extra = {}) => configureStore({
    reducer: { fraudCases, auth },
    preloadedState: { auth: { user: { id: 'me', name: 'Me', email: 'me@x.com' }, isAuthenticated: true, loading: false, error: null, checkAuthRequestId: null }, ...extra },
  });

  it('list: error kept / cleared, stale answers ignored', async () => {
    const store = make();
    api.get.mockRejectedValueOnce(err('boom'));
    await store.dispatch(fetchCasesThunk());
    expect(store.getState().fraudCases).toMatchObject({ error: 'boom', loading: false });

    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchCasesThunk({ status: 'OPEN' }));
    const pB = store.dispatch(fetchCasesThunk({ status: 'RESOLVED' }));
    expect(store.getState().fraudCases.error).toBe('');
    b.resolve(list([{ _id: 'resolved' }]));
    await pB;
    a.resolve(list([{ _id: 'open' }]));
    await pA;
    expect(store.getState().fraudCases.cases).toEqual([{ _id: 'resolved' }]);
  });

  it('detail: opening case A then B shows only B; failure keeps detailError; clear ignores a late answer', async () => {
    const store = make();
    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchCaseByIdThunk('A'));
    const pB = store.dispatch(fetchCaseByIdThunk('B'));
    b.resolve({ data: { data: { _id: 'B', publicId: 'CASE-B' } } });
    await pB;
    a.resolve({ data: { data: { _id: 'A', publicId: 'CASE-A' } } });
    await pA;
    expect(store.getState().fraudCases.selectedCase._id).toBe('B');

    const late = pendingRequest();
    api.get.mockReturnValueOnce(late.promise);
    const pLate = store.dispatch(fetchCaseByIdThunk('C'));
    store.dispatch(clearSelectedCase());
    late.resolve({ data: { data: { _id: 'C' } } });
    await pLate;
    expect(store.getState().fraudCases.selectedCase).toBeNull();

    api.get.mockRejectedValueOnce(err('Case not found', 404));
    await store.dispatch(fetchCaseByIdThunk('D'));
    expect(store.getState().fraudCases).toMatchObject({ detailError: 'Case not found', detailLoading: false });
  });

  it('write requests are counted separately from list / detail loading', async () => {
    const store = make();
    const w = pendingRequest();
    api.patch.mockReturnValueOnce(w.promise);
    const p = store.dispatch(assignCaseThunk({ id: 'c1' }));
    expect(store.getState().fraudCases).toMatchObject({ pendingWrites: 1, loading: false, detailLoading: false });
    w.resolve({ data: { data: { publicId: 'CASE-1', status: 'ASSIGNED', assignedAnalystId: 'me' } } });
    await p;
    expect(store.getState().fraudCases.pendingWrites).toBe(0);
    api.patch.mockRejectedValueOnce(err('nope', 403));
    await store.dispatch(assignCaseThunk({ id: 'c1' }));
    expect(store.getState().fraudCases.pendingWrites).toBe(0);
  });

  it('the saved note (with _id and a string author) is appended with the author rebuilt from the session', async () => {
    const store = make({
      fraudCases: { ...fraudCases(undefined, { type: '@@init' }), selectedCase: { _id: 'c1', publicId: 'CASE-1', notes: [] } },
    });
    api.post.mockResolvedValueOnce({ data: { success: true, data: { _id: 'n1', analystId: 'me', text: 'Checked', createdAt: '2026-10-06T00:00:00Z' } } });
    await store.dispatch(addCaseNoteThunk({ id: 'c1', note: 'Checked' }));
    expect(store.getState().fraudCases.selectedCase.notes).toEqual([
      { _id: 'n1', analystId: { _id: 'me', name: 'Me', email: 'me@x.com' }, text: 'Checked', createdAt: '2026-10-06T00:00:00Z' },
    ]);
  });

  it('a note that finishes after the user opened another case is not added to that other case', async () => {
    const store = make({
      fraudCases: { ...fraudCases(undefined, { type: '@@init' }), selectedCase: { _id: 'other', publicId: 'CASE-2', notes: [] } },
    });
    api.post.mockResolvedValueOnce({ data: { success: true, data: { _id: 'n1', analystId: 'me', text: 'x', createdAt: 'now' } } });
    await store.dispatch(addCaseNoteThunk({ id: 'c1', note: 'x' }));
    expect(store.getState().fraudCases.selectedCase.notes).toEqual([]);
  });
});

describe('notifications', () => {
  const make = () => storeOf({ notifications });
  it('keeps the error, clears it on pending and ignores a stale answer', async () => {
    const store = make();
    api.get.mockRejectedValueOnce(err('offline'));
    await store.dispatch(fetchNotificationsThunk());
    expect(store.getState().notifications).toMatchObject({ error: 'offline', loading: false });

    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchNotificationsThunk({ page: 1 }));
    const pB = store.dispatch(fetchNotificationsThunk({ page: 2 }));
    expect(store.getState().notifications.error).toBe('');
    b.resolve(list([{ _id: 'new' }]));
    await pB;
    a.resolve(list([{ _id: 'old' }]));
    await pA;
    expect(store.getState().notifications.notifications).toEqual([{ _id: 'new' }]);
  });
});

describe('analytics', () => {
  const make = () => storeOf({ analytics });
  it('analytics and trends have independent errors, loading flags and stale guards', async () => {
    const store = make();
    api.get.mockRejectedValueOnce(err('analytics down')).mockRejectedValueOnce(err('trends down'));
    await Promise.all([store.dispatch(fetchAnalyticsThunk()), store.dispatch(fetchLossStatsThunk())]);
    expect(store.getState().analytics).toMatchObject({ error: 'analytics down', lossError: 'trends down', loading: false, lossLoading: false });

    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchAnalyticsThunk());
    const pB = store.dispatch(fetchAnalyticsThunk());
    expect(store.getState().analytics).toMatchObject({ error: '', lossError: 'trends down', loading: true });
    b.resolve({ data: { data: { totalTransactions: 2 } } });
    await pB;
    a.resolve({ data: { data: { totalTransactions: 1 } } });
    await pA;
    expect(store.getState().analytics.totalTransactions).toBe(2);
  });

  it('a stale trends answer is ignored', async () => {
    const store = make();
    const a = pendingRequest(); const b = pendingRequest();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pA = store.dispatch(fetchLossStatsThunk());
    const pB = store.dispatch(fetchLossStatsThunk());
    b.resolve({ data: { data: { dailyTrend: [{ date: 'new' }], peakFraudHours: [] } } });
    await pB;
    a.resolve({ data: { data: { dailyTrend: [{ date: 'old' }], peakFraudHours: [] } } });
    await pA;
    expect(store.getState().analytics.lossStats.dailyTrend).toEqual([{ date: 'new' }]);
  });
});
