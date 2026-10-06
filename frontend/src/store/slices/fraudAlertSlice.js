/**
 * @file src/store/slices/fraudAlertSlice.js
 * @description Redux slice for fraud alert state.
 *   State: { alerts[], selectedAlert, filters, pagination,
 *            flagged{ items[], pagination }, selectedFlagged,
 *            loading, detailLoading, flaggedLoading, flaggedDetailLoading,
 *            error, detailError, flaggedError, flaggedDetailError, + one *RequestId per thunk }
 *   N-02 / N-03: every thunk has its own loading flag and (for fetches) its own error string,
 *   cleared on pending; only the latest request of a thunk may write its result.
 *   CUSTOMER thunks: fetchFraudAlertsThunk, fetchFraudAlertByIdThunk (/customer-api)
 *   ANALYST thunks (AUD-13, Phase 2 spec "fetchFlaggedTransactionsThunk (analyst view)"):
 *     fetchFlaggedTransactionsThunk     → GET /analyst-api/flagged-transactions
 *     fetchFlaggedTransactionByIdThunk  → GET /analyst-api/flagged-transactions/:id
 *       payload { transaction, deviceReputation, fraudAlert, existingCase } —
 *       fraudAlert._id is what createCaseThunk needs as fraudAlertId.
 *   Analysts MUST use the analyst thunks: /customer-api returns 403 for them.
 *   Live action: addLiveFraudAlert (dispatched by useSocket on 'fraud_alert' event)
 *
 *   Response unwrapping (D-P6-23, C-P6-18..C-P6-19):
 *     List:   { success, data: [...alerts], pagination: { total, page, limit, pages } }
 *     Single: { success, data: { ...alert } }
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-05, D-P6-15, D-P6-23
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { createCaseThunk } from './fraudCaseSlice.js';
import { getErrorMessage, rejectedMessage } from '../../api/errors.js'; // AUD-32

/** Live socket alerts kept in `alerts` (N-20: the array used to grow for the whole session). */
const MAX_LIVE_ALERTS = 100;

const initialState = {
  alerts: [],
  selectedAlert: null,
  filters: {
    riskLevel: '',
    status:    '',
  },
  pagination: {
    page:  1,
    total: 0,
    limit: 10,
  },
  // Analyst view: system-wide HIGH/CRITICAL transactions (AUD-13)
  flagged: {
    items: [],
    pagination: { page: 1, total: 0, limit: 20 },
  },
  selectedFlagged: null, // { transaction, deviceReputation, fraudAlert, existingCase }
  loading: false,              // customer alert list in flight
  detailLoading: false,        // customer alert detail in flight
  flaggedLoading: false,       // analyst flagged list in flight
  flaggedDetailLoading: false, // analyst investigation context in flight
  error: '',
  detailError: '',
  flaggedError: '',
  flaggedDetailError: '',
  listRequestId: null,
  detailRequestId: null,
  flaggedRequestId: null,
  flaggedDetailRequestId: null,
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/**
 * Fetch paginated fraud alerts for the authenticated customer.
 * Phase 4 response: { success, data: [...alerts], pagination: { total, page, limit, pages } }
 * @param {{ page?: number, riskLevel?: string, status?: string }} params
 */
export const fetchFraudAlertsThunk = createAsyncThunk(
  'fraudAlerts/fetchAll',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.CUSTOMER.FRAUD_ALERTS, { params });
      // C-P6-18: was `return data` — reducer read action.payload.alerts (undefined)
      return {
        alerts: data.data,
        total:  data.pagination.total,
        page:   data.pagination.page,
        limit:  data.pagination.limit,
      };
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch fraud alerts'));
    }
  },
);

/**
 * Fetch a single fraud alert by ID.
 * Phase 4 response: { success, data: { ...alert } }
 * @param {string} id
 */
export const fetchFraudAlertByIdThunk = createAsyncThunk(
  'fraudAlerts/fetchById',
  async (id, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`${API_PATHS.CUSTOMER.ALERT_BY_ID}/${id}`);
      return data.data; // C-P6-19: was data.alert (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Alert not found'));
    }
  },
);

/**
 * ANALYST — system-wide HIGH/CRITICAL transactions.
 * Phase 4 response: { success, data: [...transactions], pagination: { total, page, limit, pages } }
 * @param {{ page?: number, limit?: number, riskLevel?: 'HIGH'|'CRITICAL', startDate?: string, endDate?: string }} params
 */
export const fetchFlaggedTransactionsThunk = createAsyncThunk(
  'fraudAlerts/fetchFlagged',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.ANALYST.FLAGGED_TRANSACTIONS, { params });
      return {
        items: data.data,
        total: data.pagination.total,
        page:  data.pagination.page,
        limit: data.pagination.limit,
      };
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch flagged transactions'));
    }
  },
);

/**
 * ANALYST — full investigation context for one transaction.
 * Phase 4 response: { success, data: { transaction, deviceReputation, fraudAlert, existingCase } }
 * @param {string} id — transaction _id
 */
export const fetchFlaggedTransactionByIdThunk = createAsyncThunk(
  'fraudAlerts/fetchFlaggedById',
  async (id, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`${API_PATHS.ANALYST.TRANSACTION_DETAIL}/${id}`);
      return data.data;
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Transaction not found'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const fraudAlertSlice = createSlice({
  name: 'fraudAlerts',
  initialState,
  reducers: {
    /**
     * Prepend a live fraud alert received via Socket.io 'fraud_alert' event.
     * Dispatched by useSocket.js (Admin) for real-time dashboard updates.
     * @param {Object} action.payload - Alert object from socket event
     */
    addLiveFraudAlert(state, action) {
      // FE-fix: the socket payload has no _id/status; give it the list-item keys
      // pages rely on (key = transactionId) without overwriting real ones.
      const p = action.payload ?? {};
      state.alerts.unshift({ status: 'OPEN', ...p, _id: p._id ?? p.transactionId });
      if (state.alerts.length > MAX_LIVE_ALERTS) state.alerts.length = MAX_LIVE_ALERTS; // N-20
      state.pagination.total += 1;
    },
    setAlertFilters(state, action) {
      state.filters = { ...state.filters, ...action.payload };
    },
    clearSelectedAlert(state) {
      state.selectedAlert    = null;
      state.detailRequestId  = null; // N-03: ignore a late answer for a closed detail
      state.detailLoading    = false;
      state.detailError      = '';
    },
    clearSelectedFlagged(state) {
      state.selectedFlagged        = null;
      state.flaggedDetailRequestId = null;
      state.flaggedDetailLoading   = false;
      state.flaggedDetailError     = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchFraudAlertsThunk.pending, (state, action) => {
        state.loading       = true;
        state.error         = '';
        state.listRequestId = action.meta.requestId;
      })
      .addCase(fetchFraudAlertsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return; // N-03: stale answer
        state.listRequestId    = null;
        state.loading          = false;
        state.alerts           = action.payload.alerts;
        state.pagination.total = action.payload.total;
        state.pagination.page  = action.payload.page;
        state.pagination.limit = action.payload.limit;
      })
      .addCase(fetchFraudAlertsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return;
        state.listRequestId = null;
        state.loading       = false;
        state.error         = rejectedMessage(action, 'Failed to fetch fraud alerts');
      });

    builder
      .addCase(fetchFraudAlertByIdThunk.pending, (state, action) => {
        state.detailLoading   = true;
        state.detailError     = '';
        state.detailRequestId = action.meta.requestId;
        state.selectedAlert   = null; // FE-fix: no stale record while loading / after a failure
      })
      .addCase(fetchFraudAlertByIdThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId = null;
        state.detailLoading   = false;
        state.selectedAlert   = action.payload;
      })
      .addCase(fetchFraudAlertByIdThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId = null;
        state.detailLoading   = false;
        state.detailError     = rejectedMessage(action, 'Alert not found');
      });

    // Analyst: flagged list + detail (AUD-13)
    builder
      .addCase(fetchFlaggedTransactionsThunk.pending, (state, action) => {
        state.flaggedLoading   = true;
        state.flaggedError     = '';
        state.flaggedRequestId = action.meta.requestId;
      })
      .addCase(fetchFlaggedTransactionsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.flaggedRequestId) return;
        state.flaggedRequestId         = null;
        state.flaggedLoading           = false;
        state.flagged.items            = action.payload.items;
        state.flagged.pagination.total = action.payload.total;
        state.flagged.pagination.page  = action.payload.page;
        state.flagged.pagination.limit = action.payload.limit;
      })
      .addCase(fetchFlaggedTransactionsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.flaggedRequestId) return;
        state.flaggedRequestId = null;
        state.flaggedLoading   = false;
        state.flaggedError     = rejectedMessage(action, 'Failed to fetch flagged transactions');
      });

    builder
      .addCase(fetchFlaggedTransactionByIdThunk.pending, (state, action) => {
        state.flaggedDetailLoading   = true;
        state.flaggedDetailError     = '';
        state.flaggedDetailRequestId = action.meta.requestId;
        state.selectedFlagged        = null; // FE-fix: a failed fetch must not leave the previous alert selectable
      })
      .addCase(fetchFlaggedTransactionByIdThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.flaggedDetailRequestId) return;
        state.flaggedDetailRequestId = null;
        state.flaggedDetailLoading   = false;
        state.selectedFlagged        = action.payload;
      })
      .addCase(fetchFlaggedTransactionByIdThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.flaggedDetailRequestId) return;
        state.flaggedDetailRequestId = null;
        state.flaggedDetailLoading   = false;
        state.flaggedDetailError     = rejectedMessage(action, 'Transaction not found');
      });

    // FE-fix: opening a case changes the alert (REVIEWED) and fills existingCase;
    // keep the investigation context in step so the page cannot create a 2nd case.
    builder.addCase(createCaseThunk.fulfilled, (state, action) => {
      const c = action.payload;
      const sel = state.selectedFlagged;
      if (sel?.fraudAlert && c && sel.fraudAlert._id === (c.fraudAlertId?._id ?? c.fraudAlertId)) {
        sel.fraudAlert.status = 'REVIEWED';
        sel.existingCase = {
          _id: c._id, publicId: c.publicId, status: c.status,
          assignedAnalystId: c.assignedAnalystId ?? null, openedAt: c.openedAt,
        };
      }
    });
  },
});

export const { addLiveFraudAlert, setAlertFilters, clearSelectedAlert, clearSelectedFlagged } = fraudAlertSlice.actions;
export default fraudAlertSlice.reducer;
