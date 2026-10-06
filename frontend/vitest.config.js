// vitest.config.js  (finguardai-frontend/)
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // vitest 3 bundles Vite 7, which transforms JSX with esbuild's classic runtime
  // ("React is not defined"); the app itself builds with Vite 8's automatic runtime.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.js'],
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
      },
      // N-10: report on ALL application code (it used to measure only the slices, so the
      // 80 % gate said nothing about pages, hooks or components). The enforced gate stays the
      // Phase 8 target — Redux slices ≥ 80 % — see `thresholds` above.
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx}', 'src/tests/**', 'src/main.jsx', 'src/**/index.js'],
    },
  },
});
