// eslint.config.js — ESLint 9 flat config for the backend (T-06). `npm run lint` must report zero errors.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'coverage', '.audit'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module', // the whole backend is native ESM ("type": "module")
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // Jest (native ESM) — `describe` / `it` / `expect` / `jest` are imported from @jest/globals in these files,
    // the globals below only cover tests that rely on the injected ones.
    files: ['tests/**/*.js', 'jest.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
];
