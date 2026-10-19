import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /* The first buildApp() of a run warms Fastify and its plugins: past 5 s when `pnpm test` runs every package at once. */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
