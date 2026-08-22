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
      // Ratcheted to just below the measured figures (81.8 statements, 84.6
      // lines, 81.5 functions, 72.6 branches) so a regression fails the build
      // instead of quietly eroding coverage. Raise these when coverage rises;
      // never lower them to make a run pass.
      thresholds: {
        statements: 81,
        lines: 84,
        functions: 81,
        branches: 72,
      },
    },
  },
});
