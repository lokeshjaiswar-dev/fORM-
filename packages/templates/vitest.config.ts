import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'templates',
    environment: 'node',
    testTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      /* Vitest matches the root as a prefix, so the sibling packages/templates-core would count as this package's source. */
      exclude: ['**/templates-core/**'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 90 },
    },
  },
});
