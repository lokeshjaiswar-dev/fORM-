import { defineConfig } from 'vitest/config';

/* The benchmark (`pnpm test:perf`): no coverage instrumentation and no parallel test files. */
export default defineConfig({
  test: {
    name: 'logic-perf',
    environment: 'node',
    testTimeout: 120_000,
    include: ['test/perf.test.ts'],
    fileParallelism: false,
    /* The default reporter drops console output of passing tests; the measured numbers are the point. */
    reporters: ['verbose'],
  },
});
