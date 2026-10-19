import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { DEV_CSP_REPORT_PATH, builderSecurityHeaders } from './security/headers.ts';
import { cspReportCollector, noInjectedStyles } from './security/vite.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  /* VITE_API_URL: the API origin when it is not the builder's own (SaaS: api.form.example). Unset: same origin. */
  const apiUrl = loadEnv(mode, root, 'VITE_').VITE_API_URL;
  const connectOrigins = apiUrl ? [apiUrl] : [];
  /* Same-origin API in development: `/v1` goes to `pnpm dev:api` (:8080). */
  const proxy = apiUrl ? {} : { '/v1': process.env.FR_DEV_API_URL ?? 'http://127.0.0.1:8080' };
  /* Reports go to the local collector, through `report-uri` only (see BuilderHeaderOptions.reportTo). */
  const reports = { reportUri: DEV_CSP_REPORT_PATH, reportTo: false };
  return {
    plugins: [react(), tailwindcss(), cspReportCollector(), noInjectedStyles()],
    /* Template packs (@form/templates) are imported as assets: `?inline` bundles their bytes into the app. */
    assetsInclude: ['**/*.formpack'],
    resolve: {
      alias: {
        '@': path.resolve(root, './src'),
      },
    },
    server: {
      headers: builderSecurityHeaders({ mode: 'development', connectOrigins, ...reports }),
      proxy,
    },
    /* `vite preview` serves the production build with the production policy; the e2e suite runs against it. */
    preview: {
      headers: builderSecurityHeaders({ mode: 'production', connectOrigins, ...reports }),
      proxy,
    },
  };
});
