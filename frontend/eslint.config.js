// eslint.config.js — ESLint 9 flat config (the legacy `--ext` flag no longer exists).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// T-06: eslint-plugin-react's `jsx-uses-vars` is not a dependency, so this tiny local rule does the
// same job: a component used only in JSX (<Spinner />, <Foo.Bar />) counts as used. That lets
// `no-unused-vars` run with the strict `^_` ignore pattern instead of the old blanket `^[A-Z_]`
// (which hid genuinely unused imports of every capitalised name).
const jsxUsesVars = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const mark = (node, name) => context.sourceCode.markVariableAsUsed(name, node);
    return {
      JSXOpeningElement(node) {
        let n = node.name;
        while (n.type === 'JSXMemberExpression') n = n.object; // <Foo.Bar /> uses Foo
        if (n.type === 'JSXIdentifier' && /^[A-Z]/.test(n.name)) mark(node, n.name); // lower-case = DOM tag
      },
    };
  },
};

export default [
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh, local: { rules: { 'jsx-uses-vars': jsxUsesVars } } },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'local/jsx-uses-vars': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests run under vitest (globals: true) in jsdom/node
    files: ['**/*.test.{js,jsx}', 'src/tests/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.vitest } },
  },
  {
    files: ['vite.config.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
