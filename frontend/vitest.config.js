// vitest.config.js  (frontend/)
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.js'],
    // Default is 5 s; the chart-heavy admin dashboard test needed more on a slower laptop under parallel load.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        'src/store/slices/*.js': {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        // T-02: pages are gated too (they were at 0 % for several files before the round-1 tests;
        // the aggregate is ~90 % lines now). Kept below the measured values so a small refactor
        // does not trip it, but a page losing its tests would.
        'src/pages/**/*.jsx': {
          lines: 85,
          functions: 80,
          branches: 80,
          statements: 85,
        },
      },
      // N-10: report on ALL application code (it used to measure only the slices, so the
      // 80 % gate said nothing about pages, hooks or components). The enforced gates are the
      // Phase 8 target — Redux slices ≥ 80 % — and, since T-02, the pages — see `thresholds` above.
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx}', 'src/tests/**', 'src/main.jsx', 'src/**/index.js'],
    },
  },
});
