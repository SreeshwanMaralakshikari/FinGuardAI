// client/src/store/slices/__tests__/simulationSlice.test.js
import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import simulationReducer, { addSimulationEvent } from '../simulationSlice.js';

function makeStore() {
  return configureStore({ reducer: { simulation: simulationReducer } });
}

describe('simulationSlice — addSimulationEvent', () => {
  it('adds an event to the events array', () => {
    const store = makeStore();
    store.dispatch(addSimulationEvent({ type: 'TRANSACTION', message: 'Test event', timestamp: Date.now() }));

    const state = store.getState().simulation;
    expect(state.events.length).toBe(1);
    expect(state.events[0].type).toBe('TRANSACTION');
  });
});

describe('D-P6-20 — events array capped at 100', () => {
  it('does not exceed 100 events after adding 110', () => {
    const store = makeStore();

    for (let i = 0; i < 110; i++) {
      store.dispatch(addSimulationEvent({ type: 'TXN', message: `Event ${i}`, timestamp: Date.now() + i }));
    }

    const state = store.getState().simulation;
    expect(state.events.length).toBe(100);
  });

  it('keeps the LAST 100 events (discards oldest)', () => {
    const store = makeStore();

    for (let i = 0; i < 110; i++) {
      store.dispatch(addSimulationEvent({ type: 'TXN', message: `Event ${i}`, timestamp: i }));
    }

    const state = store.getState().simulation;
    // First event should be #10 (0-indexed), last should be #109
    expect(state.events[0].message).toBe('Event 10');
    expect(state.events[99].message).toBe('Event 109');
  });

  it('exactly 100 events — no truncation occurs', () => {
    const store = makeStore();

    for (let i = 0; i < 100; i++) {
      store.dispatch(addSimulationEvent({ type: 'TXN', message: `Ev ${i}`, timestamp: i }));
    }

    const state = store.getState().simulation;
    expect(state.events.length).toBe(100);
  });
});
