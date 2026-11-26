import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builderCsp, builderSecurityHeaders, deployEnv, embedHeaders, isEmbedPath, isFramablePath, nginxHeaders, productionEmbedHeaders, productionEmbedPageHeaders, productionHeaderSets, productionHeaders, productionHeadersForPath, sandboxedEmbedCsp, sandboxedEmbedHeaders } from './headers.ts';

const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));

describe('builder security headers (FND-20)', () => {
  it('production: script and style from self only, no framing, Trusted Types enforced', () => {
    const csp = directives(builderCsp({ mode: 'production', reportUri: '/__csp-report' }));
    expect(csp).toEqual({
      'default-src': "'self'",
      'script-src': "'self'",
      'style-src': "'self'",
      'img-src': "'self' data: blob:",
      'font-src': "'self'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'self'",
      'frame-ancestors': "'none'",
      'require-trusted-types-for': "'script'",
      'trusted-types': "'none'",
      'report-uri': '/__csp-report',
      'report-to': 'csp',
    });
    const headers = builderSecurityHeaders({ mode: 'production', reportUri: '/__csp-report' });
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Reporting-Endpoints']).toBe('csp="/__csp-report"');
    expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined();
    const legacy = builderSecurityHeaders({ mode: 'production', reportUri: '/__csp-report', reportTo: false });
    expect(directives(legacy['Content-Security-Policy'] ?? '')['report-to']).toBeUndefined();
    expect(directives(legacy['Content-Security-Policy'] ?? '')['report-uri']).toBe('/__csp-report');
    expect(legacy['Reporting-Endpoints']).toBeUndefined();
  });

  it('development allows Vite inline scripts and styles and only reports Trusted Types', () => {
    const headers = builderSecurityHeaders({ mode: 'development', reportUri: '/__csp-report' });
    const csp = directives(headers['Content-Security-Policy'] ?? '');
    expect(csp['script-src']).toBe("'self' 'unsafe-inline'");
    expect(csp['frame-ancestors']).toBe("'none'");
    expect(csp['require-trusted-types-for']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBe("require-trusted-types-for 'script'; trusted-types 'none'; report-uri /__csp-report; report-to csp");
  });

  it('development can allow extra connect origins (demo validation API)', () => {
    const headers = builderSecurityHeaders({
      mode: 'development',
      connectOrigins: ['http://localhost:3001'],
      reportUri: '/__csp-report',
      reportTo: false,
    });
    expect(directives(headers['Content-Security-Policy'] ?? '')['connect-src']).toBe("'self' http://localhost:3001");
  });

  it('a separate API origin is allowed to connect and receives the reports', () => {
    const headers = productionHeaders({ PUBLIC_API_URL: 'https://api.form.example/' });
    const csp = directives(headers['Content-Security-Policy'] ?? '');
    expect(csp['connect-src']).toBe("'self' https://api.form.example");
    expect(csp['report-uri']).toBe('https://api.form.example/v1/csp-reports');
    expect(headers['Reporting-Endpoints']).toBe('csp="https://api.form.example/v1/csp-reports"');
    expect(directives(productionHeaders({})['Content-Security-Policy'] ?? '')['report-uri']).toBe('/v1/csp-reports');
  });

  it('the production serving guide carries the generated nginx lines', () => {
    const doc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/platform/builder-security-headers.md'), 'utf8').replaceAll('\r\n', '\n');
    const block = (lines: string) => lines.split('\n').map((l) => `  ${l}`).join('\n');
    expect(doc).toContain(block(nginxHeaders(productionHeaders({ PUBLIC_API_URL: 'https://api.form.example' }))));
    expect(doc).toContain(block(nginxHeaders(productionHeaders({}))));
  });

  it('the framable embed set: framed by the listed origins and its own, no X-Frame-Options, and NO report endpoint (BD-09); the rest is the plain set', () => {
    const plain = builderSecurityHeaders({ mode: 'production', reportUri: '/__csp-report' });
    const embed = embedHeaders({ mode: 'production', reportUri: '/__csp-report' }, ['https://dms.example/', 'http://192.168.1.54:3000']);
    expect(directives(embed['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'self' https://dms.example http://192.168.1.54:3000");
    expect(embed['X-Frame-Options']).toBeUndefined();
    expect(directives(plain['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'none'");
    expect(plain['X-Frame-Options']).toBe('DENY');
    // No receiver for CSP reports on the DMS hosts: none of the three report pieces is on an embed set, whatever the caller passed.
    const csp = directives(embed['Content-Security-Policy'] ?? '');
    expect(csp['report-uri']).toBeUndefined();
    expect(csp['report-to']).toBeUndefined();
    expect(embed['Reporting-Endpoints']).toBeUndefined();
    expect(plain['Reporting-Endpoints']).toBe('csp="/__csp-report"');
    const { 'X-Frame-Options': _a, 'Reporting-Endpoints': _b, ...plainRest } = plain;
    const { 'Content-Security-Policy': plainCsp, ...plainOther } = plainRest;
    expect({ ...embed, 'Content-Security-Policy': '' }).toEqual({ ...plainOther, 'Content-Security-Policy': '' });
    expect(plainCsp).toContain('report-uri');
    expect(directives(embed['Content-Security-Policy'] ?? '')['script-src']).toBe("'self'");
    // No listed parent: framable by the page's own origin only (a sandboxed child has no use for that: the build refuses to accept any parent).
    expect(directives(embedHeaders({ mode: 'production' }, [])['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'self'");
  });

  it('a wildcard or non-origin entry is not an ancestor', () => {
    expect(() => embedHeaders({ mode: 'production' }, ['*'])).toThrow();
  });

  it('isEmbedPath matches the embed prefix under the base and nothing that merely contains the word', () => {
    expect(isEmbedPath('/embed/dms-upload?fp_parent=x')).toBe(true);
    expect(isEmbedPath('/embed')).toBe(true);
    expect(isEmbedPath('/embed/')).toBe(true);
    expect(isEmbedPath('/formplus/embed/dms-upload', '/formplus/')).toBe(true);
    expect(isEmbedPath('/embed/dms-upload', '/formplus/')).toBe(false);
    for (const url of ['/f/embed', '/forms/embed/responses', '/embedded', '/embed.js', '/', '/forms', undefined, '//embed/x']) expect(isEmbedPath(url as string | undefined), String(url)).toBe(false);
  });

  it('the generated /embed/ location lines carry no report endpoint (docs/platform/builder-security-headers.md still prints the old block: needsFromOtherLane)', () => {
    const lines = nginxHeaders(productionEmbedHeaders({ FP_EMBED_PARENTS: 'https://dms.example' }));
    expect(lines).toContain("frame-ancestors 'self' https://dms.example;");
    expect(lines).not.toMatch(/report-uri|report-to|Reporting-Endpoints|csp-reports/);
    expect(directives(productionEmbedHeaders({ FP_EMBED_PARENTS: ' https://a.example , https://b.example/ ' })['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'self' https://a.example https://b.example");
  });

  it('connect-src lists FP_DMS_API_ORIGINS (normalised to origins) on the embed and the plain production headers', () => {
    const env = { PUBLIC_API_URL: 'https://api.form.example', FP_DMS_API_ORIGINS: ' https://dms-api.example/api , http://192.168.1.54:8000/ ' };
    const connect = (h: Record<string, string>) => directives(h['Content-Security-Policy'] ?? '')['connect-src'];
    expect(connect(productionEmbedHeaders({ ...env, FP_EMBED_PARENTS: 'https://dms.example' }))).toBe("'self' https://api.form.example https://dms-api.example http://192.168.1.54:8000");
    expect(connect(productionHeaders(env))).toBe("'self' https://api.form.example https://dms-api.example http://192.168.1.54:8000");
    expect(connect(productionEmbedHeaders({}))).toBe("'self'");
    expect(connect(productionHeaders({}))).toBe("'self'");
    expect(() => productionEmbedHeaders({ FP_DMS_API_ORIGINS: 'not a url' })).toThrow();
  });

  it('the generated embed block with a DMS API origin differs from the guide only by that origin in connect-src', () => {
    const withDms = productionEmbedHeaders({ FP_EMBED_PARENTS: 'https://dms.example', FP_DMS_API_ORIGINS: 'https://dms-api.example' })['Content-Security-Policy'] ?? '';
    expect(withDms).toContain("connect-src 'self' https://dms-api.example;");
    expect(withDms).toContain("frame-ancestors 'self' https://dms.example;");
  });

  it('only /embed/dms-upload is framable; /embed/dms-master is a top-level page', () => {
    expect(isFramablePath('/embed/dms-upload')).toBe(true);
    expect(isFramablePath('/embed/dms-upload?fp_parent=x#y')).toBe(true);
    expect(isFramablePath('/embed/dms-upload/')).toBe(true);
    expect(isFramablePath('/formplus/embed/dms-upload', '/formplus/')).toBe(true);
    for (const url of ['/embed/dms-master', '/embed/dms-master?x=1', '/embed', '/embed/', '/embed/dms-uploads', '/embed/dms-record', '/forms', '/formplus/embed/dms-upload', '/embed/dms-upload/x', '/embed/dms-upload/..%2Fdms-master', '/embed/dms-upload/x/', undefined]) {
      expect(isFramablePath(url as string | undefined), String(url)).toBe(false);
    }
  });
});

describe('production headers from the build environment (VITE_*)', () => {
  const build = {
    VITE_API_URL: 'https://api.form.example/',
    VITE_FP_DMS_API_ORIGINS: 'https://dms-api.example/api, http://192.168.1.54:8000',
    VITE_FP_DMS_API_BASE: '/api,https://dms-base.example/api/v1',
    VITE_FP_EMBED_PARENTS: 'https://dms.example, https://classic.example/',
  };
  const csp = (h: Record<string, string>) => directives(h['Content-Security-Policy'] ?? '');

  it('connect-src lists VITE_FP_DMS_API_ORIGINS and the absolute VITE_FP_DMS_API_BASE origins on both header sets', () => {
    const { plain, embed } = productionHeaderSets(build);
    const want = "'self' https://api.form.example https://dms-api.example http://192.168.1.54:8000 https://dms-base.example";
    expect(csp(plain)['connect-src']).toBe(want);
    expect(csp(embed)['connect-src']).toBe(want);
  });

  it('only the embed set is framable, by VITE_FP_EMBED_PARENTS and the page itself; the plain set and X-Frame-Options stay shut', () => {
    const { plain, embed } = productionHeaderSets(build);
    expect(csp(embed)['frame-ancestors']).toBe("'self' https://dms.example https://classic.example");
    expect(embed['X-Frame-Options']).toBeUndefined();
    expect(csp(plain)['frame-ancestors']).toBe("'none'");
    expect(plain['X-Frame-Options']).toBe('DENY');
  });

  it('per route under /formplus/: dms-upload framable; dms-master, dms-record, record sub-paths and the SPA are not', () => {
    const frame = (url: string) => csp(productionHeadersForPath(url, build, '/formplus/'))['frame-ancestors'];
    expect(frame('/formplus/embed/dms-upload?fp_v=2')).toBe("'self' https://dms.example https://classic.example");
    for (const url of ['/formplus/embed/dms-master', '/formplus/embed/dms-record', '/formplus/embed/dms-record/x', '/formplus/', '/formplus/forms', '/embed/dms-upload']) {
      expect(frame(url), url).toBe("'none'");
    }
  });

  it('the FP_* names win over the VITE_* ones, and an unset environment is the plain same-origin policy', () => {
    expect(deployEnv({ ...build, FP_DMS_API_ORIGINS: 'https://other.example', PUBLIC_API_URL: 'https://api2.example', FP_EMBED_PARENTS: 'https://p.example' })).toEqual({
      PUBLIC_API_URL: 'https://api2.example',
      FP_DMS_API_ORIGINS: 'https://other.example,https://dms-base.example',
      FP_EMBED_PARENTS: 'https://p.example',
      FP_PUBLIC_ORIGINS: 'https://p.example', // default: the embed parents
      LEGACY: false,
    });
    const none = productionHeaderSets({});
    expect(csp(none.plain)['connect-src']).toBe("'self'");
    expect(csp(none.embed)['frame-ancestors']).toBe("'self'");
  });

  it('a malformed origin fails the build instead of shipping a broken policy', () => {
    expect(() => productionHeaderSets({ VITE_FP_DMS_API_ORIGINS: 'not a url' })).toThrow();
    expect(() => productionHeaderSets({ VITE_FP_EMBED_PARENTS: '*' })).toThrow();
  });
});

describe('sandboxedEmbed: the header set of /embed/dms-upload (SEC-DESIGN 3.3, T-61)', () => {
  const opts = { parents: ['https://dms.example', 'https://classic.example/'], publicOrigins: ['https://dms.example'] };

  it('is exactly the target of SEC-DESIGN 3.3', () => {
    expect(sandboxedEmbedCsp(opts)).toBe(
      [
        'sandbox allow-scripts allow-forms',
        "default-src 'none'",
        "script-src 'self' https://dms.example",
        "style-src 'self' https://dms.example",
        "img-src 'self' https://dms.example data: blob:",
        "font-src 'self' https://dms.example",
        "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self' https://dms.example https://classic.example",
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
      ].join('; '),
    );
    expect(sandboxedEmbedHeaders(opts)).toEqual({
      'Content-Security-Policy': sandboxedEmbedCsp(opts),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
  });

  it('sandboxes the document (opaque origin) even top-level, never grants allow-same-origin, and opens no network', () => {
    const csp = directives(sandboxedEmbedCsp(opts));
    expect(csp['sandbox']).toBe('allow-scripts allow-forms');
    expect(sandboxedEmbedCsp(opts)).not.toContain('allow-same-origin');
    expect(csp['connect-src']).toBe("'none'");
    expect(csp['form-action']).toBe("'none'");
    expect(csp['default-src']).toBe("'none'");
    expect(csp['require-trusted-types-for']).toBe("'script'");
  });

  it('has no report endpoint at all, no X-Frame-Options (it frames by CSP), and no COOP', () => {
    const headers = sandboxedEmbedHeaders(opts);
    expect(sandboxedEmbedCsp(opts)).not.toMatch(/report-uri|report-to/);
    expect(Object.keys(headers).sort()).toEqual(['Cache-Control', 'Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options']);
  });

  it('lists the public origins explicitly beside self; they default to the parents; a wildcard or a malformed origin fails', () => {
    expect(directives(sandboxedEmbedCsp({ parents: ['https://dms.example'] }))['script-src']).toBe("'self' https://dms.example");
    expect(directives(sandboxedEmbedCsp({ parents: ['https://dms.example'], publicOrigins: [] }))['font-src']).toBe("'self' https://dms.example");
    expect(directives(sandboxedEmbedCsp({ parents: ['https://dms.example'], publicOrigins: ['https://a.example', 'https://b.example/path'] }))['style-src']).toBe("'self' https://a.example https://b.example");
    expect(() => sandboxedEmbedCsp({ parents: ['*'] })).toThrow();
    expect(() => sandboxedEmbedCsp({ parents: ['https://dms.example'], publicOrigins: ['not a url'] })).toThrow();
  });

  it('no listed parent still frames by the page itself only (the page refuses every parent at run time)', () => {
    expect(directives(sandboxedEmbedCsp({ parents: [] }))['frame-ancestors']).toBe("'self'");
  });
});

describe('the production header sets of one build: plain, embed page, upload (T-61)', () => {
  const env = { VITE_FP_EMBED_PARENTS: 'https://dms.example', FP_PUBLIC_ORIGINS: 'https://dms.example', VITE_FP_DMS_API_ORIGINS: 'https://dms-api.example', VITE_API_URL: 'https://api.form.example' };
  const csp = (h: Record<string, string>) => directives(h['Content-Security-Policy'] ?? '');

  it('default build: the upload set is the sandboxed one; FP_PUBLIC_ORIGINS defaults to VITE_FP_EMBED_PARENTS', () => {
    const { upload } = productionHeaderSets(env);
    expect(csp(upload)['sandbox']).toBe('allow-scripts allow-forms');
    expect(csp(upload)['script-src']).toBe("'self' https://dms.example");
    expect(csp(upload)['report-uri']).toBeUndefined();
    expect(upload['Cache-Control']).toBe('no-store');
    expect(csp(productionHeaderSets({ VITE_FP_EMBED_PARENTS: 'https://dms.example' }).upload)['script-src']).toBe("'self' https://dms.example");
    expect(csp(productionHeaderSets({ ...env, FP_PUBLIC_ORIGINS: 'https://public.example' }).upload)['script-src']).toBe("'self' https://public.example");
  });

  it('M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1): the upload set keeps today\'s framable set, minus report-uri, plus no-store; it is not sandboxed', () => {
    const { upload } = productionHeaderSets({ ...env, VITE_FP_LEGACY_DESCRIPTOR: '1' });
    expect(csp(upload)['sandbox']).toBeUndefined();
    expect(csp(upload)['frame-ancestors']).toBe("'self' https://dms.example");
    expect(csp(upload)['connect-src']).toBe("'self' https://api.form.example https://dms-api.example");
    expect(csp(upload)['report-uri']).toBeUndefined();
    expect(upload['Reporting-Endpoints']).toBeUndefined();
    expect(upload['X-Frame-Options']).toBeUndefined();
    expect(upload['Cache-Control']).toBe('no-store');
    expect(deployEnv({ ...env, VITE_FP_LEGACY_DESCRIPTOR: '1' }).LEGACY).toBe(true);
    expect(deployEnv({ ...env, VITE_FP_LEGACY_DESCRIPTOR: '' }).LEGACY).toBe(false);
    expect(deployEnv(env).LEGACY).toBe(false);
  });

  it('the full-page embeds (dms-master, dms-record) get the plain set without report-uri; the SPA keeps its reports', () => {
    const { plain, embedPage } = productionHeaderSets(env);
    expect(csp(embedPage)['frame-ancestors']).toBe("'none'");
    expect(embedPage['X-Frame-Options']).toBe('DENY');
    expect(csp(embedPage)['report-uri']).toBeUndefined();
    expect(csp(embedPage)['report-to']).toBeUndefined();
    expect(embedPage['Reporting-Endpoints']).toBeUndefined();
    expect(csp(embedPage)['connect-src']).toBe(csp(plain)['connect-src']);
    expect(csp(plain)['report-uri']).toBe('https://api.form.example/v1/csp-reports');
    expect(productionEmbedPageHeaders({})['Content-Security-Policy']).not.toContain('report');
  });

  it('per path: upload set, embed-page set, plain set', () => {
    const for_ = (url: string) => productionHeadersForPath(url, env, '/formplus/');
    expect(csp(for_('/formplus/embed/dms-upload?fp_v=2'))['sandbox']).toBeDefined();
    for (const url of ['/formplus/embed/dms-master', '/formplus/embed/dms-record', '/formplus/embed/dms-record/x', '/formplus/embed/dms-upload/x']) {
      expect(csp(for_(url))['report-uri'], url).toBeUndefined();
      expect(csp(for_(url))['sandbox'], url).toBeUndefined();
    }
    for (const url of ['/formplus/', '/formplus/forms', '/formplus/builder/1']) expect(csp(for_(url))['report-uri'], url).toBe('https://api.form.example/v1/csp-reports');
  });
});
