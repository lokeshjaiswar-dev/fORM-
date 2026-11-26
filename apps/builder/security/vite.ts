import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { DEV_CSP_REPORT_PATH, isFramablePath } from './headers.ts';

const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORTS = 500;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REPORT_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_REPORT_BYTES ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) return void res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Violation reports for the Vite dev and preview servers: `POST` stores a report (legacy `application/csp-report` or a
 * Reporting API batch) and logs one line, `GET` lists them and `DELETE` clears them (the e2e CSP test reads them). The
 * production builder reports to `POST /v1/csp-reports` on the API instead.
 */
export function cspReportCollector(): Plugin {
  const reports: unknown[] = [];
  const handler: Connect.NextHandleFunction = (req, res) => {
    if (req.method === 'GET') return send(res, 200, reports);
    if (req.method === 'DELETE') {
      reports.length = 0;
      return send(res, 204);
    }
    if (req.method !== 'POST') return send(res, 405);
    readBody(req).then(
      (body) => {
        if (body === null) return send(res, 413);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400);
        }
        for (const report of Array.isArray(parsed) ? parsed : [parsed]) {
          if (reports.length >= MAX_REPORTS) reports.shift();
          reports.push(report);
          const r = report as { 'csp-report'?: Record<string, unknown>; body?: Record<string, unknown> };
          const b = r['csp-report'] ?? r.body ?? {};
          console.warn(`[csp] ${String(b['effective-directive'] ?? b.effectiveDirective ?? '?')} blocked ${String(b['blocked-uri'] ?? b.blockedURL ?? '?')}`);
        }
        send(res, 204);
      },
      () => send(res, 400),
    );
  };
  return {
    name: 'fr-csp-report-collector',
    configureServer: (server) => void server.middlewares.use(DEV_CSP_REPORT_PATH, handler),
    configurePreviewServer: (server) => void server.middlewares.use(DEV_CSP_REPORT_PATH, handler),
  };
}

/** sonner's module-level `__insertCSS("…")` call: one string literal argument. */
const SONNER_INSERT_CSS = /\n__insertCSS\("(?:[^"\\\n]|\\.)*"\);?/g;

/**
 * Production builds only. sonner injects its stylesheet as a `<style>` element when it loads, which `style-src 'self'`
 * refuses; the build drops that call and main.tsx imports `sonner/dist/styles.css` into the bundled CSS. A sonner
 * release that changes the call fails the build here instead of shipping a violation.
 */
export function noInjectedStyles(): Plugin {
  return {
    name: 'fr-no-injected-styles',
    apply: 'build',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.mjs$/.test(id.split('?')[0] ?? '')) return null;
      const calls = code.match(SONNER_INSERT_CSS)?.length ?? 0;
      if (calls !== 1) this.error(`sonner: expected one __insertCSS("…") call to remove, found ${calls}; review security/vite.ts`);
      return { code: code.replace(SONNER_INSERT_CSS, '\n'), map: null };
    },
  };
}

/**
 * `/embed/dms-upload` (the only route that runs in a frame) may be framed by DMS+ (VITE_FP_EMBED_PARENTS) while every other
 * route, `/embed/dms-master` included, stays `frame-ancestors 'none'`.
 * Vite's `server.headers` and `preview.headers` are one set for all paths, so this replaces the framing headers on the
 * response of a framable path just before its head is written, whichever middleware set them first. `headers` is the
 * full set the route gets (`sandboxedEmbedHeaders(...)` or `embedHeaders(...)`); headers it does not carry (`X-Frame-Options`,
 * the plain set's COOP and report endpoints) are removed.
 *
 * `rewriteTo` (a file under the base, `embed-upload.html`): the framable path is served from that entry instead of the SPA, as
 * nginx does (`deploy/nginx.conf.template`): the upload page is its own entry that runs in an opaque origin.
 */
export function embedFraming(headers: Record<string, string>, base = '/', options: { rewriteTo?: string } = {}): Plugin {
  const replaced = ['Content-Security-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Reporting-Endpoints', 'Content-Security-Policy-Report-Only'];
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (isFramablePath(req.url, base)) {
      if (options.rewriteTo !== undefined) {
        const query = (req.url ?? '').match(/[?#].*$/)?.[0] ?? '';
        req.url = `${base.replace(/\/+$/, '')}/${options.rewriteTo}${query}`;
      }
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      res.writeHead = ((...args: unknown[]) => {
        for (const name of replaced) if (!(name in headers)) res.removeHeader(name);
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        return writeHead(...args);
      }) as typeof res.writeHead;
    }
    next();
  };
  return {
    name: 'fr-embed-framing',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

/**
 * The built assets (`<base>assets/*`, hashed, public) answer `Access-Control-Allow-Origin: *`, as `location ^~ /formplus/assets/` does in
 * nginx (SEC-DESIGN 3.3 B2): the sandboxed upload page has an opaque origin and loads its module scripts, stylesheet and fonts in CORS
 * mode with `Origin: null`. Only the assets get it: never a page, never an API response. `vite preview` has no CORS on its static
 * files (the e2e suite and the cross-origin spec run against it); the dev server already allows any origin.
 */
export function assetCors(base = '/'): Plugin {
  const prefix = `${base.replace(/\/+$/, '')}/assets/`;
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? '').split(/[?#]/)[0] ?? '';
    if (path.startsWith(prefix) && (req.method === 'GET' || req.method === 'HEAD')) res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  };
  return {
    name: 'fr-asset-cors',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}
