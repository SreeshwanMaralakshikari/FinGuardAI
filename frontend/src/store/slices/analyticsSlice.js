/**
 * @file src/store/slices/analyticsSlice.js
 * @description Redux slice for admin analytics dashboard state.
 *   State: { fraudByHour[], fraudByPaymentMethod[], fraudByDevice[], scoreHistogram[], fraudByLocation[], riskDistribution[],
 *            lossPrevented, lossStats{}, loading, lossLoading, error, lossError, *RequestId }
 *   N-02 / N-03: each request has its own loading flag and error string (cleared on pending);
 *   only the latest request of a thunk may write its result.
 *   A-01: fraudByPaymentMethod[] = [{paymentMethod,count}] (was wrongly named fraudByDevice);
 *         fraudByDevice[] = [{deviceId,count,userCount}] is the REAL top-device list;
 *         scoreHistogram[] = [{from,to,label,count}] (10 buckets of the fraud score).
 *         lossPrevented stores the INR scalar from GET /admin-api/analytics (C-P6-11)
 *
 *   Response unwrapping (D-P6-23, C-P6-28..C-P6-29):
 *     Analytics: { success, data: { fraudByHour, fraudByPaymentMethod, fraudByLocation,
 *                  riskDistribution, lossPrevented, totalTransactions, fraudRate, ... } }
 *     Trends:    { success, data: { dailyTrend[], peakFraudHours[] } }
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-11, D-P6-12, D-P6-22, D-P6-23
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage, rejectedMessage } from '../../api/errors.js'; // AUD-32

const initialState = {
  fraudByHour:       [],
  fraudByPaymentMethod: [], // [{ paymentMethod, count }]
  fraudByDevice:     [],  // A-01: [{ deviceId, count, userCount }]
  scoreHistogram:    [],  // A-01: [{ from, to, label, count }]
  fraudByLocation:   [],
  riskDistribution:  [],
  lossPrevented:     0,   // INR scalar from GET /admin-api/analytics (C-P6-11, D-P6-22)
  // AUD-33: KPI tiles of the admin dashboard (were discarded by the reducer)
  totalTransactions: 0,
  fraudRate:         0,   // % of transactions rated HIGH/CRITICAL
  openCases:         0,
  openAlerts:        0,
  lossStats:         {},  // { dailyTrend[], peakFraudHours[] } from GET /admin-api/analytics/trends
  range:             {},  // A-01: startDate/endDate of the last explicit fetch
  loading:           false,
  lossLoading:       false, // FE-fix: trends request had to share `loading` with analytics
  error:             '',    // N-02: message of the last failed analytics fetch
  lossError:         '',    // N-02: message of the last failed trends fetch
  analyticsRequestId: null, // N-03
  lossRequestId:      null, // N-03
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/**
 * Fetch main analytics summary.
 * @param {{ startDate?: string, endDate?: string }} [params] IST day bounds (see utils/dates.js dateRangeParams);
 *   omitted = reuse the last range (state.range) so a live refresh never drops the dashboard's date filter
 * Phase 4 response: { success, data: { totalTransactions, fraudRate, riskDistribution,
 *   fraudByHour, fraudByPaymentMethod, fraudByLocation, lossPrevented, openCases, openAlerts } }
 */
export const fetchAnalyticsThunk = createAsyncThunk(
  'analytics/fetchAnalytics',
  async (params, { getState, rejectWithValue }) => {
    // no argument (socket refresh, demo-data refresh) = keep the range the dashboard is showing
    const range = params ?? getState().analytics?.range ?? {};
    try {
      const { data } = await (Object.keys(range).length > 0
        ? api.get(API_PATHS.ADMIN.ANALYTICS, { params: range })
        : api.get(API_PATHS.ADMIN.ANALYTICS));
      return data.data; // C-P6-28: was `return data` — reducer read action.payload.fraudByHour (undefined)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch analytics'));
    }
  },
);

/**
 * Fetch loss statistics / trend data.
 * Phase 4 response: { success, data: { dailyTrend[], peakFraudHours[] } }
 */
export const fetchLossStatsThunk = createAsyncThunk(
  'analytics/fetchLossStats',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.ADMIN.LOSS_STATS);
      return data.data; // C-P6-29: was `return data` — lossStats stored the entire envelope
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch loss stats'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const analyticsSlice = createSlice({
  name: 'analytics',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAnalyticsThunk.pending, (state, action) => {
        state.loading            = true;
        state.error              = '';
        state.analyticsRequestId = action.meta.requestId;
        if (action.meta.arg !== undefined) state.range = action.meta.arg;
      })
      .addCase(fetchAnalyticsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.analyticsRequestId) return; // N-03: stale answer
        // action.payload = data.data = { fraudByHour, fraudByPaymentMethod, ... }
        state.analyticsRequestId = null;
        state.loading          = false;
        state.fraudByHour      = action.payload.fraudByHour         ?? [];
        state.fraudByPaymentMethod = action.payload.fraudByPaymentMethod ?? [];  // D-P6-11
        state.fraudByDevice    = action.payload.fraudByDevice        ?? [];  // A-01
        state.scoreHistogram   = action.payload.scoreHistogram       ?? [];  // A-01
        state.fraudByLocation  = action.payload.fraudByLocation      ?? [];
        state.riskDistribution = action.payload.riskDistribution     ?? [];
        state.lossPrevented    = action.payload.lossPrevented        ?? 0;   // C-P6-11
        state.totalTransactions = action.payload.totalTransactions   ?? 0;   // AUD-33
        state.fraudRate         = action.payload.fraudRate           ?? 0;
        state.openCases         = action.payload.openCases           ?? 0;
        state.openAlerts        = action.payload.openAlerts          ?? 0;
      })
      .addCase(fetchAnalyticsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.analyticsRequestId) return;
        state.analyticsRequestId = null;
        state.loading            = false;
        state.error              = rejectedMessage(action, 'Failed to fetch analytics');
      });

    builder
      .addCase(fetchLossStatsThunk.pending, (state, action) => {
        state.lossLoading   = true;
        state.lossError     = '';
        state.lossRequestId = action.meta.requestId;
      })
      .addCase(fetchLossStatsThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.lossRequestId) return;
        // action.payload = data.data = { dailyTrend[], peakFraudHours[] }
        state.lossRequestId = null;
        state.lossLoading   = false;
        state.lossStats     = action.payload;
      })
      .addCase(fetchLossStatsThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.lossRequestId) return;
        state.lossRequestId = null;
        state.lossLoading   = false;
        state.lossError     = rejectedMessage(action, 'Failed to fetch loss stats');
      });
  },
});

export default analyticsSlice.reducer;
