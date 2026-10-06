/**
 * @file src/store/slices/fraudCaseSlice.js
 * @description Redux slice for analyst fraud case management state.
 *   State: { cases[], selectedCase, filters, pagination,
 *            loading, detailLoading, pendingWrites, error, detailError, listRequestId, detailRequestId }
 *   Case statuses: OPEN | ASSIGNED | UNDER_REVIEW | RESOLVED | DISMISSED
 *   N-02 / N-03: `loading` = list in flight, `detailLoading` = detail in flight, `pendingWrites` =
 *   number of create / assign / status / note requests in flight; fetch failures are kept in
 *   `error` / `detailError`; only the latest list / detail request may write its result.
 *
 *   Response unwrapping (D-P6-23, C-P6-20..C-P6-25):
 *     List:   { success, data: [...cases], pagination: { total, page, limit, pages } }
 *     Single (GET /:id, POST /): { success, data: { ...fraudCase } }  ← full document
 *
 *   PARTIAL mutation responses (D-P6-24, C-P6-31):
 *     PATCH /:id/assign  → data.data = { publicId, status, assignedAnalystId }  ← no _id
 *     PATCH /:id/status  → data.data = { publicId, status, resolvedAt }          ← no _id
 *     POST  /:id/notes   → data.data = note { _id, analystId, text, createdAt }   ← not a case
 *     These three use per-thunk inline reducers (NOT applySelectedCase).
 *     applySelectedCase is used ONLY for fetchCaseByIdThunk (full document).
 *
 *   NOTE (C-P6-30): addCaseNoteThunk sends { text: note } — Phase 4 validates body('text').
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-16, D-P6-04, D-P6-23, D-P6-24
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage, rejectedMessage } from '../../api/errors.js'; // AUD-32

const initialState = {
  cases: [],
  selectedCase: null,
  filters: {
    status:       '',
    assignedToMe: false,
  },
  pagination: {
    page:  1,
    total: 0,
    limit: 20,
  },
  loading: false,         // list request in flight
  detailLoading: false,   // detail request in flight
  pendingWrites: 0,       // create / assign / status / note requests in flight
  error: '',              // N-02: message of the last failed list fetch
  detailError: '',        // N-02: message of the last failed detail fetch
  listRequestId: null,    // N-03: only this list request may write its result
  detailRequestId: null,  // N-03: only this detail request may write its result
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/** @param {{ page?: number, status?: string, assignedToMe?: boolean }} params */
export const fetchCasesThunk = createAsyncThunk(
  'fraudCases/fetchAll',
  async (params = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.get(API_PATHS.ANALYST.CASES, { params });
      // C-P6-20: was `return data` — reducer read action.payload.cases (undefined)
      return {
        cases: data.data,
        total: data.pagination.total,
        page:  data.pagination.page,
        limit: data.pagination.limit,
      };
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to fetch cases'));
    }
  },
);

/** @param {string} id */
export const fetchCaseByIdThunk = createAsyncThunk(
  'fraudCases/fetchById',
  async (id, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`${API_PATHS.ANALYST.CASE_BY_ID}/${id}`);
      return data.data; // C-P6-21: was data.fraudCase (undefined) — full document returned here
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Case not found'));
    }
  },
);

/** @param {{ fraudAlertId: string, initialNote?: string }} payload */
export const createCaseThunk = createAsyncThunk(
  'fraudCases/create',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.ANALYST.CREATE_CASE, payload);
      return data.data; // C-P6-22: was data.fraudCase (undefined) — full document returned here
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to create case'));
    }
  },
);

/**
 * @param {{ id: string, status: string, resolutionSummary?: string }} payload
 * AUD-07: Phase 4 updateStatusRules REQUIRE resolutionSummary when status is
 * RESOLVED or DISMISSED — sending only { status } always returned 422, so
 * cases could never be closed from the UI.
 */
export const updateCaseStatusThunk = createAsyncThunk(
  'fraudCases/updateStatus',
  async ({ id, status, resolutionSummary }, { rejectWithValue }) => {
    try {
      const body = resolutionSummary ? { status, resolutionSummary } : { status };
      const { data } = await api.patch(`${API_PATHS.ANALYST.UPDATE_CASE_STATUS}/${id}/status`, body);
      return data.data; // C-P6-23: partial { publicId, status, resolvedAt } — no _id (D-P6-24)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to update status'));
    }
  },
);

/**
 * Self-assign: the backend always assigns the case to the logged-in analyst
 * (req.user._id) and ignores any analystId in the body.
 * @param {{ id: string }} payload
 */
export const assignCaseThunk = createAsyncThunk(
  'fraudCases/assign',
  async ({ id, analystId }, { rejectWithValue, getState }) => {
    try {
      const { data } = await api.patch(`${API_PATHS.ANALYST.ASSIGN_CASE}/${id}/assign`, { analystId });
      // FE-fix: the server answers with a bare id string, but GET /cases and GET /cases/:id
      // return a populated { _id, name, email }. The caller is always the new assignee
      // (the backend ignores any other analystId), so rebuild the populated shape here.
      const me = getState()?.auth?.user;
      const res = data.data;
      if (me?.id && typeof res?.assignedAnalystId === 'string') {
        return { ...res, assignedAnalystId: { _id: res.assignedAnalystId, name: me.name, email: me.email } };
      }
      return res; // C-P6-24: partial { publicId, status, assignedAnalystId } — no _id (D-P6-24)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to assign case'));
    }
  },
);

/**
 * @param {{ id: string, note: string }} payload
 * The server answers with the saved note { _id, analystId: <string>, text, createdAt }.
 * C-P6-30: sends { text: note } — Phase 4 addNoteRules validates body('text'), reads req.body.text.trim()
 */
export const addCaseNoteThunk = createAsyncThunk(
  'fraudCases/addNote',
  async ({ id, note }, { rejectWithValue, getState }) => {
    try {
      // C-P6-30: was { note } — Phase 4 expects field name 'text', not 'note'
      const { data } = await api.post(`${API_PATHS.ANALYST.ADD_CASE_NOTE}/${id}/notes`, { text: note });
      // FE-fix: GET /cases/:id returns notes[].analystId populated ({ _id, name, email });
      // POST returns a bare id string, so rebuild the populated author from the session.
      const me = getState()?.auth?.user;
      const res = data.data;
      if (me?.id && typeof res?.analystId === 'string') {
        return { ...res, analystId: { _id: res.analystId, name: me.name, email: me.email } };
      }
      return res; // C-P6-25: note object { _id, analystId, text, createdAt } — not a case (D-P6-24)
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to add note'));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

/**
 * Update selectedCase and matching item in cases[] from a FULL case document.
 * ONLY call this for thunks that return a full case (fetchCaseByIdThunk).
 * DO NOT use for updateCaseStatusThunk / assignCaseThunk / addCaseNoteThunk
 * — those return partial objects without _id (D-P6-24, C-P6-31).
 */
function applySelectedCase(state, fraudCase) {
  state.selectedCase = fraudCase;
  const idx = state.cases.findIndex((c) => c._id === fraudCase._id);
  if (idx !== -1) state.cases[idx] = fraudCase;
}

const beginWrite = (state) => { state.pendingWrites += 1; };
const endWrite   = (state) => { state.pendingWrites = Math.max(0, state.pendingWrites - 1); };

const fraudCaseSlice = createSlice({
  name: 'fraudCases',
  initialState,
  reducers: {
    setCaseFilters(state, action) {
      state.filters = { ...state.filters, ...action.payload };
    },
    clearSelectedCase(state) {
      state.selectedCase    = null;
      state.detailRequestId = null; // N-03: ignore a late answer for a case the user left
      state.detailLoading   = false;
      state.detailError     = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCasesThunk.pending, (state, action) => {
        state.loading       = true;
        state.error         = '';
        state.listRequestId = action.meta.requestId;
      })
      .addCase(fetchCasesThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return; // N-03: stale answer
        state.listRequestId    = null;
        state.loading          = false;
        state.cases            = action.payload.cases;
        state.pagination.total = action.payload.total;
        state.pagination.page  = action.payload.page;
        state.pagination.limit = action.payload.limit;
      })
      .addCase(fetchCasesThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.listRequestId) return;
        state.listRequestId = null;
        state.loading       = false;
        state.error         = rejectedMessage(action, 'Failed to fetch cases');
      });

    builder
      .addCase(fetchCaseByIdThunk.pending, (state, action) => {
        state.detailLoading   = true;
        state.detailError     = '';
        state.detailRequestId = action.meta.requestId;
        // FE-fix: never keep showing another case while this one loads / if it fails
        if (state.selectedCase && state.selectedCase._id !== action.meta.arg) state.selectedCase = null;
      })
      .addCase(fetchCaseByIdThunk.fulfilled, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId = null;
        state.detailLoading   = false;
        applySelectedCase(state, action.payload);
      })
      .addCase(fetchCaseByIdThunk.rejected, (state, action) => {
        if (action.meta.requestId !== state.detailRequestId) return;
        state.detailRequestId = null;
        state.detailLoading   = false;
        state.detailError     = rejectedMessage(action, 'Case not found');
      });

    builder
      .addCase(createCaseThunk.pending, beginWrite)
      .addCase(createCaseThunk.fulfilled, (state) => {
        endWrite(state);
        // FE-fix: POST /cases returns an UNPOPULATED document, but the list holds populated
        // items (transactionId.publicId, assignedAnalystId.name …). Inserting it broke list rows;
        // the case list refetches on mount, so just count it.
        state.pagination.total += 1;
      })
      .addCase(createCaseThunk.rejected, endWrite);

    // C-P6-31: inline reducer — PATCH /cases/:id/status returns partial { publicId, status, resolvedAt }
    builder
      .addCase(updateCaseStatusThunk.pending, beginWrite)
      .addCase(updateCaseStatusThunk.fulfilled, (state, action) => {
        endWrite(state);
        const { publicId, status, resolvedAt } = action.payload;
        const idx = state.cases.findIndex((c) => c.publicId === publicId);
        if (idx !== -1) {
          state.cases[idx] = { ...state.cases[idx], status, resolvedAt };
        }
        if (state.selectedCase?.publicId === publicId) {
          state.selectedCase = { ...state.selectedCase, status, resolvedAt };
        }
      })
      .addCase(updateCaseStatusThunk.rejected, endWrite);

    // C-P6-31: inline reducer — PATCH /cases/:id/assign returns partial { publicId, status, assignedAnalystId }
    builder
      .addCase(assignCaseThunk.pending, beginWrite)
      .addCase(assignCaseThunk.fulfilled, (state, action) => {
        endWrite(state);
        const { publicId, status, assignedAnalystId } = action.payload;
        const idx = state.cases.findIndex((c) => c.publicId === publicId);
        if (idx !== -1) {
          state.cases[idx] = { ...state.cases[idx], status, assignedAnalystId };
        }
        if (state.selectedCase?.publicId === publicId) {
          state.selectedCase = { ...state.selectedCase, status, assignedAnalystId };
        }
      })
      .addCase(assignCaseThunk.rejected, endWrite);

    // C-P6-31: inline reducer — POST /cases/:id/notes returns the saved note { _id, analystId, text, createdAt }
    builder
      .addCase(addCaseNoteThunk.pending, beginWrite)
      .addCase(addCaseNoteThunk.fulfilled, (state, action) => {
        endWrite(state);
        // action.payload = note object — push to selectedCase.notes[], but only when the case
        // on screen is still the one the note was written to (N-03)
        if (state.selectedCase && state.selectedCase._id === action.meta.arg.id) {
          if (!state.selectedCase.notes) state.selectedCase.notes = [];
          state.selectedCase.notes.push(action.payload);
        }
      })
      .addCase(addCaseNoteThunk.rejected, endWrite);
  },
});

export const { setCaseFilters, clearSelectedCase } = fraudCaseSlice.actions;
export default fraudCaseSlice.reducer;
