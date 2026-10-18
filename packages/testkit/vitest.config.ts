import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'testkit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
