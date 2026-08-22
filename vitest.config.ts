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
      // Ratcheted to just below the measured figures (80.2 statements, 82.9
      // lines, 79.6 functions, 71.1 branches) so a regression fails the build
      // instead of quietly eroding coverage. Raise these when coverage rises;
      // never lower them to make a run pass.
      thresholds: {
        statements: 79,
        lines: 82,
        functions: 79,
        branches: 70,
      },
    },
  },
});
