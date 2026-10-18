import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'validation',
    environment: 'node',
    testTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      /* Phase 0 exit gate: validation ≥ 90% line coverage. */
      thresholds: { lines: 90 },
    },
  },
});
