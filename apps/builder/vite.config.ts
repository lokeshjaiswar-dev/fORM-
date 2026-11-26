import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { DEV_CSP_REPORT_PATH, builderSecurityHeaders } from './security/headers.ts';
import { cspReportCollector, noInjectedStyles } from './security/vite.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

/** This computer's IPv4 addresses on the local network (no loopback, no virtual switches), for preview links. */
function networkAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/vethernet|virtual|vmware|virtualbox|docker|wsl|loopback/i.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((info) => info.family === 'IPv4' && !info.internal)
    .map((info) => info.address);
}

export default defineConfig(({ mode }) => {
  /* VITE_API_URL: the API origin when it is not the builder's own (SaaS: api.form.example). Unset: same origin. */
  const apiUrl = loadEnv(mode, root, 'VITE_').VITE_API_URL;
  /* Dev preview POSTs field API checks from the browser; CSP connect-src must allow the demo validator. */
  const demoValidate = mode === 'development' ? ['http://localhost:3001', 'http://127.0.0.1:3001'] : [];
  const connectOrigins = [...(apiUrl ? [apiUrl] : []), ...demoValidate];
  /* Same-origin API in development: `/v1` goes to `pnpm dev:api` (:8080). */
  const proxy = apiUrl ? {} : { '/v1': process.env.FR_DEV_API_URL ?? 'http://127.0.0.1:8080' };
  /* Reports go to the local collector, through `report-uri` only (see BuilderHeaderOptions.reportTo). */
  const reports = { reportUri: DEV_CSP_REPORT_PATH, reportTo: false };
  return {
    plugins: [react(), tailwindcss(), cspReportCollector(), noInjectedStyles()],
    /* Dev only: lets a builder opened on localhost make preview links others on the network can open. */
    define: { 'import.meta.env.VITE_NETWORK_ADDRESSES': JSON.stringify(mode === 'development' ? networkAddresses().join(',') : '') },
    /* Template packs (@form/templates) are imported as assets: `?inline` bundles their bytes into the app. */
    assetsInclude: ['**/*.formpack'],
    build: {
      /*
       * Fonts stay files. Vite would inline the smallest font subsets (under 4 KB, such as JetBrains Mono's Cyrillic
       * Extended) as data: URLs, which the production policy's `font-src 'self'` blocks. Other small assets keep the
       * default (undefined = Vite decides).
       */
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    },
    resolve: {
      alias: {
        '@': path.resolve(root, './src'),
      },
    },
    server: {
      host: true,
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
