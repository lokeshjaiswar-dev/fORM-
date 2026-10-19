import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /* Template packs (@form/templates) are imported as assets: `?inline` bundles their bytes into the app. */
  assetsInclude: ['**/*.formpack'],
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
    },
  },
});
