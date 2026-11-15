import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
     * The default 5 s test timeout stays, so a test that becomes slow shows up (BL-177). The one slow thing is the first
     * buildApp() of a run, which loads Fastify and its plugins (past 5 s when `pnpm test` runs every package at once):
     * app.test.ts pays for it in a beforeAll, which this longer hook timeout covers.
     */
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
