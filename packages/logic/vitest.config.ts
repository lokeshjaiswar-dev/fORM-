import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'logic',
    environment: 'node',
    testTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    /* Timing runs alone, without coverage: `pnpm test:perf` (vitest.perf.config.ts). */
    exclude: ['test/perf.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      /* Phase 0 exit gate: logic ≥ 90% line coverage. */
      thresholds: { lines: 90 },
    },
  },
});
