/**
 * @file src/store/slices/transactionSlice.js
 * @description Redux slice for customer transaction state.
 *   State: { transactions[], pagination, selectedTransaction, filters,
 *            loading, detailLoading, submitting, error, detailError, listRequestId, detailRequestId }
 *   Thunks: fetchTransactionsThunk, fetchTransactionByIdThunk, submitTransactionThunk
 *
 *   N-02 / N-03: each thunk has its own loading flag (`loading` = list), a failed list/detail
 *   fetch keeps its message in `error` / `detailError` (cleared on pending), and only the
 *   LATEST list / detail request may write its result — a slower, older answer is ignored.
 *
 *   Response unwrapping (D-P6-23, C-P6-15..C-P6-17, C-P6-32..C-P6-33):
 *     List:   { success, data: [...], pagination: { total, page, limit, pages } }
 *     Single: { success, data: { transaction, deviceReputation } }  ← COMPOSITE (C-P6-32)
 *             state.selectedTransaction = { transaction, deviceReputation }
 *             Phase 7: access selectedTransaction.transaction for txn fields,
 *                      selectedTransaction.deviceReputation for device context
 *     Submit: { success, data: <flat transaction summary> }  ← FLAT, no sub-keys (C-P6-33)
 *             Fields: id, publicId, amount, merchantName, merchantCategory, paymentMethod,
 *                     fraudScore, riskLevel, reasons, recommendedAction, estimatedLoss,
 *                     status, fraudAlert, timestamp
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-04, D-P6-23
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage, rejectedMessage } from '../../api/errors.js'; // AUD-32

const initialState = {
  transactions: [],
  pagination: {
    page:  1,
    total: 0,
    limit: 10,
  },
  selectedTransaction: null,
  filters: {
    riskLevel: '',
    dateRange: { startDate: '', endDate: '' },
  },
  loading: false,        // list request in flight
  detailLoading: false,  // detail request in flight
  submitting: false,     // submit request in flight
  error: '',             // N-02: message of the last failed list fetch
  detailError: '',       // N-02: message of the last failed detail fetch
  listRequestId: null,   // N-03: only this list request may write its result
  detailRequestId: null, // N-03: only this detail request may write its result
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/**
 * Fetch paginated transaction list for the authenticated customer.
 * Phase 4 response: { success, data: [...transactions], pagination: { total, page, limit, pages } }
 * @param {{ page?: number, limit?: number, riskLevel?: string, startDate?: string, endDate?: string }} params
 */
export const fetchTransactionsThunk = createAsyncThunk(
  'transactions/fetchAll',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.CUSTOMER.TRANSACTIONS, { params });
      // C-P6-15: was `return data` — reducer read action.payload.transactions (undefined)
      return {
        transactions: data.data,
        total:        data.pagination.total,
        page:         data.pagination.page,
        limit:        data.pagination.limit,
      };
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch transactions'));
    }
  },
);

/**
 * Fetch a single transaction by ID.
 * Phase 4 response: { success, data: { transaction, deviceReputation } }  ← COMPOSITE (C-P6-32)
 * state.selectedTransaction = { transaction, deviceReputation }
 * Phase 7 NOTE: access selectedTransaction.transaction for txn fields,
 *               selectedTransaction.deviceReputation for device context.
 * @param {string} id
 */
export const fetchTransactionByIdThunk = createAsyncThunk(
  'transactions/fetchById',
  async (id, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`${API_PATHS.CUSTOMER.TRANSACTION_BY_ID}/${id}`);
      return data.data; // C-P6-16: was data.transaction (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Transaction not found'));
    }
  },
);

/**
 * Submit a new transaction for fraud evaluation.
 * Phase 4 response: { success, data: <flat transaction summary> }  ← FLAT (C-P6-33)
 * action.payload = data.data = flat object (id, publicId, amount, fraudScore, status, etc.)
 * @param {Object} transactionPayload
 */
export const submitTransactionThunk = createAsyncThunk(
  'transactions/submit',
  async (transactionPayload, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.CUSTOMER.SUBMIT_TRANSACTION, transactionPayload);
      return data.data; // C-P6-17: was `return data`
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Transaction submission failed'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const transactionSlice = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    setTransactionFilters(state, action) {
      state.filters = { ...state.filters, ...action.payload };
    },
    clearSelectedTransaction(state) {
      state.selectedTransaction = null;
      // N-03: a late answer for a detail the user already closed must not repopulate it
      state.detailRequestId = null;
      state.detailLoading   = false;
      state.detailError     = '';
    },
  },
  extraReducers: (builder) => {
    // fetchAll
    builder
      .addCase(fetchTransactionsThunk.pending, (state, action) => {
        state.loading       = true;
        state.error         = '';
        state.listRequestId = action.meta.requestId;
      })
      .addCase(fetchTransactionsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return; // N-03: stale answer
        state.listRequestId       = null;
        state.loading             = false;
        state.transactions        = action.payload.transactions;
        state.pagination.total    = action.payload.total;
        state.pagination.page     = action.payload.page;
        state.pagination.limit    = action.payload.limit;
      })
      .addCase(fetchTransactionsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return;
        state.listRequestId = null;
        state.loading       = false;
        state.error         = rejectedMessage(action, 'Failed to fetch transactions');
      });

    // fetchById — action.payload = { transaction, deviceReputation } composite (C-P6-32)
    builder
      .addCase(fetchTransactionByIdThunk.pending, (state, action) => {
        state.detailLoading       = true;
        state.detailError         = '';
        state.detailRequestId     = action.meta.requestId;
        state.selectedTransaction = null; // FE-fix: no stale detail while loading / after a failure
      })
      .addCase(fetchTransactionByIdThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId     = null;
        state.detailLoading       = false;
        state.selectedTransaction = action.payload; // composite { transaction, deviceReputation }
      })
      .addCase(fetchTransactionByIdThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId = null;
        state.detailLoading   = false;
        state.detailError     = rejectedMessage(action, 'Transaction not found');
      });

    // submit — action.payload = flat transaction summary object (C-P6-33)
    builder
      .addCase(submitTransactionThunk.pending, (state) => {
        state.submitting = true;
      })
      .addCase(submitTransactionThunk.fulfilled, (state, action) => {
        state.submitting = false;
        // C-P6-33: action.payload IS the flat object — no .transaction sub-key
        // AUD-34: the POST response names the id `id`; list items (GET) use `_id`.
        // Normalise so a click on the new row opens /transactions/<_id>, not /undefined.
        state.transactions.unshift({ ...action.payload, _id: action.payload._id ?? action.payload.id });
        state.pagination.total += 1;
      })
      .addCase(submitTransactionThunk.rejected, (state) => {
        state.submitting = false;
      });
  },
});

export const { setTransactionFilters, clearSelectedTransaction } = transactionSlice.actions;
export default transactionSlice.reducer;
