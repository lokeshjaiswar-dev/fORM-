import { defineConfig } from 'tsup';

/**
 * Workspace packages are TypeScript sources and get bundled; npm dependencies stay external so the OTel
 * loader hook can patch them. Splitting keeps fastify and pg out of the entry chunk, which starts telemetry first.
 */
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
