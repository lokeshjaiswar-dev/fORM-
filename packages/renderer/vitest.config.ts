import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'renderer',
    environment: 'node',
    testTimeout: 30_000,
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
