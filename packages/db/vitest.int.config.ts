import { defineConfig } from 'vitest/config';

/** Integration tests against Postgres in Testcontainers (CI job `db`). */
export default defineConfig({
  test: {
    name: 'db:int',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
