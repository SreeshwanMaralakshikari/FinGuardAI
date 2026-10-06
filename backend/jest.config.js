// jest.config.js  (finguardai-backend/)
// Native ES Modules: run with `node --experimental-vm-modules` (see package.json "test" script).
export default {
  testEnvironment: 'node',
  transform: {},                         // no Babel — native ESM (D-P8-01)
  setupFiles: ['<rootDir>/tests/env.js'],
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    'validators/**/*.js',
  ],
  coverageThreshold: {
    './services/fraudDetectionService.js': { lines: 80, functions: 80, branches: 80 },
  },
};
