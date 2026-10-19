import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/* The typing benchmark (`pnpm test:perf`): no coverage instrumentation and no parallel test files. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
    },
  },
  test: {
    name: 'builder-perf',
    environment: 'jsdom',
    testTimeout: 120_000,
    include: ['src/perf/*.perf.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
    /* The default reporter drops console output of passing tests; the measured numbers are the point. */
    reporters: ['verbose'],
  },
});
