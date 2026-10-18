import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
