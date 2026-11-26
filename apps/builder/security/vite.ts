import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { DEV_CSP_REPORT_PATH } from './headers.ts';

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
 * Radix's `<style dangerouslySetInnerHTML>` element (Select and ScrollArea viewports: it only hides their scrollbar).
 * React writes it through innerHTML, which `require-trusted-types-for 'script'` with `trusted-types 'none'` refuses, so
 * the page that renders a Select crashes. The build renders nothing there; src/index.css carries the same rules.
 */
const RADIX_VIEWPORT_STYLE = /jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`\[data-radix-[a-z-]+-viewport\][^`]*`\s*\},\s*nonce\s*\}\s*\)/g;

interface InjectedStyle {
  name: string;
  /** Every dist entry the bundler might load for the module (ESM or CJS, any target). */
  file: RegExp;
  /** The call each loaded entry must contain exactly once. */
  pattern: RegExp;
  replacement: string;
  /** The app always bundles it: a build that never loads it resolved another entry, which would skip the strip. */
  required: boolean;
}

/** The modules whose injected stylesheet the build removes. */
const INJECTED_STYLES: readonly InjectedStyle[] = [
  { name: 'sonner __insertCSS("…")', file: /[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.m?js$/, pattern: SONNER_INSERT_CSS, replacement: '\n', required: true },
  { name: '@radix-ui/react-select viewport <style>', file: /[\\/]node_modules[\\/]@radix-ui[\\/]react-select[\\/]dist[\\/]index\.m?js$/, pattern: RADIX_VIEWPORT_STYLE, replacement: 'null', required: true },
  /* Not used by the app today; stripped if a component starts using it. */
  { name: '@radix-ui/react-scroll-area viewport <style>', file: /[\\/]node_modules[\\/]@radix-ui[\\/]react-scroll-area[\\/]dist[\\/]index\.m?js$/, pattern: RADIX_VIEWPORT_STYLE, replacement: 'null', required: false },
  /*
   * react-style-singleton (react-remove-scroll, under every Radix Dialog, Select and Popover) appends a <style> to
   * <head> while one is open; `style-src 'self'` already refuses it, so the page gains nothing and logs a violation.
   * The tag is never made; react-remove-scroll still blocks wheel and touch scrolling behind the overlay in script.
   */
  { name: 'react-style-singleton <style> tag', file: /[\\/]node_modules[\\/]react-style-singleton[\\/]dist[\\/]es(?:5|2015|2019)[\\/]singleton\.js$/, pattern: /if \(\(stylesheet = makeStyleTag\(\)\)\) \{/g, replacement: 'if ((stylesheet = null)) {', required: true },
];

/**
 * Production builds only. sonner and Radix inject stylesheets at run time, which the production policy refuses
 * (`style-src 'self'`, and Trusted Types for Radix's innerHTML). The build drops those injections; main.tsx imports
 * `sonner/dist/styles.css` and src/index.css holds Radix's viewport rules. A release that changes one of the calls
 * fails the build here instead of shipping a violation.
 */
export function noInjectedStyles(): Plugin {
  const stripped = new Set<string>();
  return {
    name: 'fr-no-injected-styles',
    apply: 'build',
    buildStart() {
      stripped.clear();
    },
    transform(code, id) {
      const file = id.split('?')[0] ?? '';
      const target = INJECTED_STYLES.find((entry) => entry.file.test(file));
      if (!target) return null;
      const calls = code.match(target.pattern)?.length ?? 0;
      if (calls !== 1) this.error(`${target.name}: expected one injected stylesheet to remove, found ${calls}; review security/vite.ts`);
      stripped.add(target.name);
      return { code: code.replace(target.pattern, target.replacement), map: null };
    },
    /* A required module that never passed through here was loaded from an entry the file patterns miss. */
    buildEnd(error) {
      if (error) return;
      const missed = INJECTED_STYLES.filter((entry) => entry.required && !stripped.has(entry.name)).map((entry) => entry.name);
      if (missed.length) this.error(`never saw ${missed.join(', ')}: the bundle loads another entry; review security/vite.ts`);
    },
  };
}
