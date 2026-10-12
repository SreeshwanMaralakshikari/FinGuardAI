// src/tests/setup.js
import '@testing-library/jest-dom';

// jsdom has no ResizeObserver and no layout; recharts' ResponsiveContainer needs both to mount a
// chart. This stub reports a fixed 800×400 box so charts render (and stay quiet) in tests.
globalThis.ResizeObserver ??= class {
  constructor(callback) { this.callback = callback; }
  observe(target) {
    this.callback([{ target, contentRect: { width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0 } }], this);
  }
  unobserve() {}
  disconnect() {}
};
