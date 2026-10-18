import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'templates-core',
    environment: 'node',
    testTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 90 },
    },
  },
});
