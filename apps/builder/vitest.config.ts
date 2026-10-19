import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  /* Template packs (@form/templates) are imported as assets: `?inline` bundles their bytes into the app. */
  assetsInclude: ['**/*.formpack'],
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
    },
  },
  test: {
    name: 'builder',
    environment: 'jsdom',
    testTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}'],
    /* Timing runs alone, without coverage: `pnpm test:perf` (vitest.perf.config.ts). */
    exclude: ['src/perf/**'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
