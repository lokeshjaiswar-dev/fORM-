import { defineConfig } from 'vite';

/* Builds the determinism harness page (index.html + harness.ts) the way the builder will ship templates-core: one browser bundle. */
export default defineConfig({
  root: import.meta.dirname,
  logLevel: 'warn',
  build: {
    outDir: '../dist/determinism',
    emptyOutDir: true,
  },
});
