import { defineConfig } from 'tsup';

/** Same shape as the api bundle: workspace sources bundled, npm dependencies external so the OTel loader hook can patch them. */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: true,
  noExternal: [/^@form\//],
});
