import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Browser tests launch Chromium and run axe audits; the API/unit suites finish far sooner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 50,
        lines: 50,
        functions: 50,
        branches: 40,
      },
    },
  },
});
