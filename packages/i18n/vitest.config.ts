import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'i18n',
    environment: 'node',
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**', 'scripts/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
