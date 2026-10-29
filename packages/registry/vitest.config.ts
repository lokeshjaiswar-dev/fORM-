import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'registry',
    environment: 'node',
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
      /* Phase 0 exit gate: registry ≥ 90% line coverage. */
      thresholds: { lines: 90 },
    },
  },
});
