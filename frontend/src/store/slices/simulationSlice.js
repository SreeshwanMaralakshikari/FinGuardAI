/**
 * @file src/store/slices/simulationSlice.js
 * @description Redux slice for admin fraud simulation state.
 *   State: { isRunning, events[], stats{} }
 *   Live actions: startSimulationLive, stopSimulationLive, addSimulationEvent
 *     — dispatched by useSocket.js on 'simulation_start' / 'simulation_stop' / 'fraud_alert' events
 *   events[] capped at 100 items (oldest evicted) to prevent unbounded growth
 *   A-08: generateSimulationThunk (POST /admin-api/simulation/generate {count}) creates REAL simulated
 *         transactions; clearSimulationDataThunk (DELETE /admin-api/simulation/data) removes them again.
 *         Both reject with a readable message (400 cap / 429 rate limit / 409 clash are explained).
 *   Note: startSimulationThunk/stopSimulationThunk fulfilled reducers do not use action.payload
 *         (isRunning is set directly) — no response unwrapping needed for these thunks
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-20, D-P6-05
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { getErrorMessage } from '../../api/errors.js'; // AUD-32

const initialState = {
  isRunning: false,
  events:    [],
  stats:     {},
};

// ─── Thunks ───────────────────────────────────────────────────────────────────

/** Start fraud simulation. POST /admin-api/simulation/start */
export const startSimulationThunk = createAsyncThunk(
  'simulation/start',
  async (payload = {}, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.ADMIN.SIMULATE_START, payload);
      return data;
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to start simulation'));
    }
  },
);

/** Stop fraud simulation. POST /admin-api/simulation/stop */
export const stopSimulationThunk = createAsyncThunk(
  'simulation/stop',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.ADMIN.SIMULATE_STOP);
      return data;
    } catch (err) {
      return rejectWithValue(getErrorMessage(err, 'Failed to stop simulation'));
    }
  },
);

/** A-08: status-aware message for the demo-data calls. */
export const SIM_TIMEOUT_MS = 120000; // R-02: up to 100 payments through the real pipeline can take a while
export const SIM_NO_ANSWER_MESSAGE = 'The server may still be generating - refresh the totals before retrying.';
export const SIM_CLEAR_NO_ANSWER_MESSAGE = 'The server may still be clearing - refresh the totals before retrying.';

function simulationMessage(err, fallback, noAnswer = SIM_NO_ANSWER_MESSAGE) {
  if (!err?.response && err?.code !== 'ERR_CANCELED' && err?.name !== 'CanceledError') return noAnswer; // timeout / dropped connection
  const status = err?.response?.status;
  const server = getErrorMessage(err, fallback);
  if (status === 429) return `Rate limit reached - ${server}`;
  if (status === 409) return `Conflict - ${server}`;
  return server;
}

/**
 * A-08: create `count` (1-100) simulated transactions through the real fraud pipeline.
 * Response data: { generated, byRiskLevel, byStatus, simulatedTransactionsTotal }
 */
export const generateSimulationThunk = createAsyncThunk(
  'simulation/generate',
  async (count, { rejectWithValue }) => {
    try {
      const { data } = await api.post(API_PATHS.ADMIN.SIMULATE_GENERATE, { count }, { timeout: SIM_TIMEOUT_MS });
      return data.data;
    } catch (err) {
      return rejectWithValue(simulationMessage(err, 'Could not generate demo data'));
    }
  },
);

/**
 * A-08: delete all simulated data.
 * Response data: { users, transactions, fraudAlerts, cases, notifications, deviceReputations, behaviorProfiles } (counts)
 */
export const clearSimulationDataThunk = createAsyncThunk(
  'simulation/clearData',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.delete(API_PATHS.ADMIN.SIMULATE_DATA, { timeout: SIM_TIMEOUT_MS });
      return data.data;
    } catch (err) {
      return rejectWithValue(simulationMessage(err, 'Could not clear demo data', SIM_CLEAR_NO_ANSWER_MESSAGE));
    }
  },
);

// ─── Slice ────────────────────────────────────────────────────────────────────

const simulationSlice = createSlice({
  name: 'simulation',
  initialState,
  reducers: {
    /**
     * Called by useSocket when 'simulation_start' event received.
     * @param {Object} action.payload - { initiatedBy, transactionCount, timestamp }
     */
    startSimulationLive(state, action) {
      state.isRunning = true;
      state.stats     = action.payload;
      state.events    = [];
    },
    /**
     * Called by useSocket when 'simulation_stop' event received.
     * @param {Object} action.payload - { stoppedBy, timestamp }
     */
    stopSimulationLive(state, action) {
      state.isRunning = false;
      state.stats     = { ...state.stats, ...action.payload };
    },
    /**
     * Append a simulation event (from 'fraud_alert' during simulation).
     * Evicts oldest events when list exceeds 100 items.
     * @param {Object} action.payload - Fraud alert / simulation event object
     */
    addSimulationEvent(state, action) {
      state.events.push(action.payload);
      if (state.events.length > 100) {
        state.events = state.events.slice(-100);
      }
    },
    clearSimulationEvents(state) {
      state.events = [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(startSimulationThunk.fulfilled, (state) => {
        state.isRunning = true;
      })
      .addCase(startSimulationThunk.rejected, () => {
        // FE-fix: leave isRunning alone — a rejected start (422, network) says nothing
        // about a simulation that is already running on the server.
      });

    builder
      .addCase(stopSimulationThunk.fulfilled, (state) => {
        state.isRunning = false;
      });
  },
});

export const {
  startSimulationLive,
  stopSimulationLive,
  addSimulationEvent,
  clearSimulationEvents,
} = simulationSlice.actions;

export default simulationSlice.reducer;
