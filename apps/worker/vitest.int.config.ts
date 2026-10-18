import { defineConfig } from 'vitest/config';

/** Worker and pg-boss against Postgres in Testcontainers (CI job `db`). */
export default defineConfig({
  test: {
    name: 'worker:int',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
