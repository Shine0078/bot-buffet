import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      // Upstream Electron/marketing material that lives untracked in this
      // working tree. `eslint .` walks the whole directory, so without these
      // the lint gate reports 17 errors from `src/renderer` and `src/main`
      // that no Bot Buffet change can fix — including a rule the config does
      // not even define — and the gate stops being usable here. None of this
      // is part of Bot Buffet and none of it is tracked.
      'src/main/**',
      'src/preload/**',
      'src/renderer/**',
      'src/shared/**',
      'blog/**',
      'hive/**',
      'landing-remotion/**',
      'prototypes/**',
      'seo/**',
      'resources/**',
      'build/**',
      'test/**',
      'tools/**',
      'docs/**',
      'electron.vite.config.ts',
      'electron-builder.yml',
      'scripts/wall-sync.mjs',
      'scripts/verify-keepalive-catchup.mjs',
      'scripts/verify-worker-gc.mjs',
      'scripts/_*.cjs',
      'scripts/_*.mjs',
      'scripts/_*.json',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
