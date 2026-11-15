import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { DEV_CSP_REPORT_PATH, builderSecurityHeaders } from './security/headers.ts';
import { cspReportCollector, noInjectedStyles } from './security/vite.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

const RADIX_VIEWPORT_CSS = 'virtual:fr-radix-viewport-styles.css';
/** The Radix modules that render their own `<style dangerouslySetInnerHTML>` (Select and ScrollArea), as a bundled path. */
const RADIX_STYLE_MODULES = /[\\/]node_modules[\\/]@radix-ui[\\/]react-(?:select|scroll-area)[\\/]dist[\\/]index\.mjs$/;
/** `jsx("style", { dangerouslySetInnerHTML: { __html: `…` }, nonce })`: the whole element, with the rule it injects captured. */
const RADIX_STYLE_ELEMENT = /\/\* @__PURE__ \*\/ jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML: \{\s*__html: `([^`]*)`\s*\},\s*nonce\s*\}\s*\)/g;

/**
 * Production builds only. Radix Select and ScrollArea hide the native scrollbar of their viewport with a `<style>`
 * element they write with `innerHTML` when a component mounts. The production policy refuses both halves of that
 * (`style-src 'self'` has no inline styles, and `require-trusted-types-for 'script'` makes a string `innerHTML` throw),
 * so any page with a Select, such as the org switcher on the forms list, stopped rendering. This takes the element out
 * of those two modules and bundles the same rules into the stylesheet instead, so the page looks the same and the
 * policy stays as written (docs/platform/builder-security-headers.md). A Radix release that changes the element fails
 * the build here instead of shipping a violation. Same idea as `noInjectedStyles` for sonner (security/vite.ts).
 */
function radixViewportStyles(): Plugin {
  const resolved = `\0${RADIX_VIEWPORT_CSS}`;
  const rules = new Set<string>();
  return {
    name: 'fr-radix-viewport-styles',
    apply: 'build',
    enforce: 'pre',
    resolveId: (source) => (source === RADIX_VIEWPORT_CSS ? resolved : null),
    load: (id) => (id === resolved ? [...rules].join('\n') : null),
    transform(code, id) {
      if (!RADIX_STYLE_MODULES.test(id.split('?')[0] ?? '')) return null;
      let found = 0;
      const next = code.replace(RADIX_STYLE_ELEMENT, (_element, css: string) => {
        found += 1;
        rules.add(css);
        return 'null';
      });
      if (found !== 1) this.error(`${id}: expected one <style dangerouslySetInnerHTML> element to replace, found ${found}; review radixViewportStyles in vite.config.ts`);
      return { code: `import ${JSON.stringify(RADIX_VIEWPORT_CSS)};\n${next}`, map: null };
    },
  };
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
    plugins: [react(), tailwindcss(), cspReportCollector(), noInjectedStyles(), radixViewportStyles()],
    /* Template packs (@form/templates) are imported as assets: `?inline` bundles their bytes into the app. */
    assetsInclude: ['**/*.formpack'],
    build: {
      /*
       * Fonts are always files. Vite inlines any asset under 4 kB as a `data:` URL, and one small JetBrains Mono subset
       * (from @dmacq/ui/fonts.css) falls under that, so the built stylesheet asked for `data:font/woff2`. The policy's
       * `font-src 'self'` refuses that (rightly: it is the production policy, docs/platform/builder-security-headers.md),
       * and every page that painted with it reported a violation. Keeping fonts out of the inline rule makes the build match
       * the policy; `undefined` leaves every other asset on Vite's default size rule.
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
