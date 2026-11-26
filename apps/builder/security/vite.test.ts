import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Connect } from 'vite';
import { embedHeaders, sandboxedEmbedHeaders } from './headers.ts';
import { embedFraming, noInjectedStyles } from './vite.ts';

type Transform = (this: { error: (m: string) => never }, code: string, id: string) => { code: string } | null;

const sonner = createRequire(import.meta.url).resolve('sonner').replace(/index\.js$/, 'index.mjs');
const transform = noInjectedStyles().transform as unknown as Transform;
const ctx = {
  error: (m: string): never => {
    throw new Error(m);
  },
};

describe('noInjectedStyles', () => {
  it('drops the installed sonner stylesheet injection and nothing else', () => {
    const code = readFileSync(sonner, 'utf8');
    const out = transform.call(ctx, code, sonner)?.code ?? '';
    expect(out).not.toMatch(/\n__insertCSS\(/);
    expect(out).toContain('function __insertCSS');
    expect(code.length - out.length).toBeGreaterThan(1000);
    expect(transform.call(ctx, code, '/x/node_modules/other/dist/index.mjs')).toBeNull();
  });

  it('fails the build when the call changes shape', () => {
    expect(() => transform.call(ctx, 'export const x = 1;', sonner)).toThrow(/expected one __insertCSS/);
  });
});

describe('embedFraming', () => {
  const headers = embedHeaders({ mode: 'production' }, ['https://dms.example']);

  /** A response whose headers were set by an earlier middleware, as vite's `server.headers` does. */
  function run(url: string, base = '/', plugin = embedFraming(headers, base)) {
    const set = new Map<string, string>([['Content-Security-Policy', "frame-ancestors 'none'"], ['X-Frame-Options', 'DENY'], ['Referrer-Policy', 'x'], ['Cross-Origin-Opener-Policy', 'same-origin'], ['Reporting-Endpoints', 'csp="/__csp-report"']]);
    let head = 0;
    const res = {
      setHeader: (k: string, v: string) => void set.set(k, v),
      removeHeader: (k: string) => void set.delete(k),
      writeHead: () => {
        head += 1;
        return res;
      },
    };
    let nexted = 0;
    let handler: Connect.NextHandleFunction | undefined;
    (plugin.configurePreviewServer as unknown as (s: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) => void)({ middlewares: { use: (h) => void (handler = h) } });
    const req = { url };
    handler!(req as never, res as never, () => void (nexted += 1));
    // Nothing is replaced until the head is written.
    const before = new Map(set);
    res.writeHead();
    return { before, set, head, nexted, url: req.url };
  }

  it('on an embed path, replaces the framing headers when the head is written and passes the request on', () => {
    const r = run('/embed/dms-upload?fp_parent=https%3A%2F%2Fdms.example');
    expect(r.nexted).toBe(1);
    expect(r.before.get('X-Frame-Options')).toBe('DENY');
    expect(r.set.get('Content-Security-Policy')).toContain("frame-ancestors 'self' https://dms.example");
    expect(r.set.has('X-Frame-Options')).toBe(false);
    expect(r.head).toBe(1);
  });

  it('honours the base path', () => {
    expect(run('/formplus/embed/dms-upload', '/formplus/').set.has('X-Frame-Options')).toBe(false);
    expect(run('/embed/dms-upload', '/formplus/').set.get('X-Frame-Options')).toBe('DENY');
  });

  it('leaves every other route as it was (/embed/dms-master is a top-level page, not framable)', () => {
    for (const url of ['/forms', '/f/embed', '/', '/builder/1', '/embed/dms-master', '/embed/dms-master?x=1', '/embed/dms-record', '/embed/dms-upload/x', '/embed/dms-upload/..%2Fdms-master']) {
      const r = run(url);
      expect(r.nexted).toBe(1);
      expect(r.set.get('X-Frame-Options')).toBe('DENY');
      expect(r.set.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    }
  });
});

describe('embedFraming for the sandboxed upload entry (T-61)', () => {
  const upload = sandboxedEmbedHeaders({ parents: ['https://dms.example'] });
  const plugin = (base = '/') => embedFraming(upload, base, { rewriteTo: 'embed-upload.html' });

  /** Same harness as above, written out so this block stands alone. */
  function run(url: string, base = '/') {
    const set = new Map<string, string>([['Content-Security-Policy', "frame-ancestors 'none'"], ['X-Frame-Options', 'DENY'], ['Referrer-Policy', 'strict-origin-when-cross-origin'], ['Cross-Origin-Opener-Policy', 'same-origin'], ['Reporting-Endpoints', 'csp="/__csp-report"'], ['Content-Security-Policy-Report-Only', "require-trusted-types-for 'script'"]]);
    const res = { setHeader: (k: string, v: string) => void set.set(k, v), removeHeader: (k: string) => void set.delete(k), writeHead: () => res };
    let handler: Connect.NextHandleFunction | undefined;
    (plugin(base).configurePreviewServer as unknown as (s: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) => void)({ middlewares: { use: (h) => void (handler = h) } });
    const req = { url };
    handler!(req as never, res as never, () => undefined);
    res.writeHead();
    return { set, url: req.url };
  }

  it('serves the framable path from the upload entry, keeping the query, and gives it exactly the sandboxed set (the plain set\'s COOP and report endpoints are removed)', () => {
    const r = run('/embed/dms-upload?fp_v=2');
    expect(r.url).toBe('/embed-upload.html?fp_v=2');
    expect(Object.fromEntries(r.set)).toEqual(upload);
    expect(r.set.get('Content-Security-Policy')).toMatch(/^sandbox allow-scripts allow-forms; /);
  });

  it('honours the base path', () => {
    const r = run('/formplus/embed/dms-upload?fp_v=2', '/formplus/');
    expect(r.url).toBe('/formplus/embed-upload.html?fp_v=2');
    expect(r.set.get('Content-Security-Policy')).toContain('sandbox');
    expect(run('/embed/dms-upload', '/formplus/').url).toBe('/embed/dms-upload');
  });

  it('rewrites and re-headers only the framable path: the SPA, dms-master, dms-record and sub-paths stay as they were', () => {
    for (const url of ['/forms', '/', '/embed/dms-master', '/embed/dms-record', '/embed/dms-upload/x', '/embed/dms-upload/..%2Fdms-master', '/embed-upload.html']) {
      const r = run(url);
      expect(r.url, url).toBe(url);
      expect(r.set.get('X-Frame-Options'), url).toBe('DENY');
      expect(r.set.get('Content-Security-Policy'), url).toBe("frame-ancestors 'none'");
    }
  });
});
