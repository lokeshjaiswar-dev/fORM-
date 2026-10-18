import { defineConfig } from 'vite';

/* Builds the determinism harness page (index.html + harness.ts) the way the renderer will ship logic: one browser bundle. */
export default defineConfig({
  root: import.meta.dirname,
  logLevel: 'warn',
  build: {
    outDir: '../dist/determinism',
    emptyOutDir: true,
  },
});
