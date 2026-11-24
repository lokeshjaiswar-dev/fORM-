import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builderCsp, builderSecurityHeaders, embedHeaders, isEmbedPath, nginxHeaders, productionEmbedHeaders, productionHeaders } from './headers.ts';

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

  it('the /embed pages may be framed by the listed origins and their own, and send no X-Frame-Options; nothing else changes', () => {
    const plain = builderSecurityHeaders({ mode: 'production', reportUri: '/__csp-report' });
    const embed = embedHeaders({ mode: 'production', reportUri: '/__csp-report' }, ['https://dms.example/', 'http://192.168.1.54:3000']);
    expect(directives(embed['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'self' https://dms.example http://192.168.1.54:3000");
    expect(embed['X-Frame-Options']).toBeUndefined();
    expect(directives(plain['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'none'");
    expect(plain['X-Frame-Options']).toBe('DENY');
    const { 'X-Frame-Options': _a, ...plainRest } = plain;
    expect({ ...embed, 'Content-Security-Policy': '' }).toEqual({ ...plainRest, 'Content-Security-Policy': '' });
    expect(directives(embed['Content-Security-Policy'] ?? '')['script-src']).toBe("'self'");
    // No listed parent: framable by the page's own origin only (the child's default allowlist).
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

  it('the production serving guide carries the generated /embed/ location lines', () => {
    const doc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/platform/builder-security-headers.md'), 'utf8').replaceAll('\r\n', '\n');
    const lines = nginxHeaders(productionEmbedHeaders({ FP_EMBED_PARENTS: 'https://dms.example' })).split('\n').map((l) => `  ${l}`).join('\n');
    expect(doc).toContain(lines);
    expect(directives(productionEmbedHeaders({ FP_EMBED_PARENTS: ' https://a.example , https://b.example/ ' })['Content-Security-Policy'] ?? '')['frame-ancestors']).toBe("'self' https://a.example https://b.example");
  });
});
