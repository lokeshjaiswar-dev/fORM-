import { defineConfig } from 'vitest/config';

/** Contracts against real cloud accounts (the nightly job); every suite skips unless its FORM_CLOUD_* variables are set. */
export default defineConfig({
  test: {
    name: 'adapters:cloud',
    environment: 'node',
    include: ['test/**/*.cloud.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
