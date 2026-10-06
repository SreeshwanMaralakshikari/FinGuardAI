/**
 * @file src/store/slices/simulationSlice.js
 * @description Redux slice for admin fraud simulation state.
 *   State: { isRunning, events[], stats{} }
 *   Live actions: startSimulationLive, stopSimulationLive, addSimulationEvent
 *     — dispatched by useSocket.js on 'simulation_start' / 'simulation_stop' / 'fraud_alert' events
 *   events[] capped at 100 items (oldest evicted) to prevent unbounded growth
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
