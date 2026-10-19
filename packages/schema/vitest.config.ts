import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'schema',
    environment: 'node',
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      only: false,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      /* Phase 0 exit gate: schema ≥ 90% line coverage. */
      thresholds: { lines: 90 },
    },
  },
});
