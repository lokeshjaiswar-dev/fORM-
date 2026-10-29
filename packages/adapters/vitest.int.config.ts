import { defineConfig } from 'vitest/config';

/** Adapter contracts against real services in Testcontainers: SeaweedFS (S3), Vault, Mailpit, and ClamAV when FORM_TEST_CLAMAV=1. */
export default defineConfig({
  test: {
    name: 'adapters:int',
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
