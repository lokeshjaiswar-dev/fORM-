import { configDefaults, defineConfig } from 'vitest/config';

/** The performance checks (`*.perf.int.test.ts`) run only with FORM_PERF=1, on the build server; the default run does not even load them. */
const perf = process.env.FORM_PERF === '1';

/** API against Postgres in Testcontainers (CI job `db`). */
export default defineConfig({
  test: {
    name: 'api:int',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    exclude: perf ? configDefaults.exclude : [...configDefaults.exclude, 'test/**/*.perf.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
