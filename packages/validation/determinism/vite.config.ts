import { defineConfig } from 'vite';

/* Builds the validation determinism harness page (index.html + harness.ts) as one browser bundle, like the renderer will ship it. */
export default defineConfig({
  root: import.meta.dirname,
  logLevel: 'warn',
  build: {
    outDir: '../dist/determinism',
    emptyOutDir: true,
  },
});
