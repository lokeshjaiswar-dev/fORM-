import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = path.resolve(here, '..');
const read = (rel: string) => readFileSync(path.join(builder, rel), 'utf8').replaceAll('\r\n', '\n');
const template = read('deploy/nginx.conf.template');
const dockerfile = read('Dockerfile');
/* The two substituted names as plain words, so a block can be matched with `[^}]*`. */
const flat = template.replace(/\$\{(FP_[A-Z_]+)\}/g, '@$1@');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let out: string | undefined;
afterEach(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  out = undefined;
});

const render = (env: Record<string, string>) => {
  out = mkdtempSync(path.join(tmpdir(), 'fp-headers-'));
  execFileSync(process.execPath, [path.join(here, 'render-nginx.ts'), out], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
  const file = (name: string) => readFileSync(path.join(out!, name), 'utf8');
  return { plain: file('plain.conf'), embedPage: file('embed-page.conf'), upload: file('upload.conf') };
};

/** The `add_header` lines of a rendered include file as a name -> value map. */
const headersOf = (conf: string): Record<string, string> =>
  Object.fromEntries([...conf.matchAll(/^add_header (\S+) "((?:[^"\\]|\\.)*)" always;$/gm)].map((m) => [m[1]!, m[2]!.replaceAll('\\"', '"')]));

/** The response headers a location gives: its own `add_header` lines plus those of the header files it includes, rendered by render-nginx for `env`. */
function effectiveHeaders(locationHead: string, env: Record<string, string>): Record<string, string> {
  const rendered = render(env);
  const block = flat.match(new RegExp(`location ${escape(locationHead)} \\{([^}]*)\\}`, 's'))?.[1];
  if (block === undefined) throw new Error(`no location ${locationHead}`);
  const own = Object.fromEntries([...block.matchAll(/add_header (\S+) "([^"]*)" always;/g)].map((m) => [m[1]!, m[2]!]));
  const files: Record<string, string> = { plain: rendered.plain, 'embed-page': rendered.embedPage, upload: rendered.upload };
  const included = [...block.matchAll(/include @FP_HEADERS_DIR@\/([a-z-]+)\.conf;/g)].map((m) => files[m[1]!] ?? '');
  return Object.assign({}, ...included.map(headersOf), own);
}

const DMS_ENV = { VITE_FP_DMS_API_ORIGINS: 'https://dms-api.example/api', VITE_FP_EMBED_PARENTS: 'https://dms.example', FP_PUBLIC_ORIGINS: 'https://dms.example', VITE_API_URL: 'https://api.form.example' };

describe('security/render-nginx.ts', () => {
  it('writes plain.conf (no framing), embed-page.conf (no framing, no report-uri) and upload.conf (the sandboxed set), all allowing the DMS API origins where they connect', () => {
    const { plain, embedPage, upload } = render(DMS_ENV);
    expect(plain).toContain("frame-ancestors 'none'");
    expect(plain).toContain('add_header X-Frame-Options "DENY" always;');
    expect(plain).toContain('report-uri https://api.form.example/v1/csp-reports');
    expect(embedPage).toContain("frame-ancestors 'none'");
    expect(embedPage).toContain('add_header X-Frame-Options "DENY" always;');
    for (const conf of [plain, embedPage]) {
      expect(conf).toContain("connect-src 'self' https://api.form.example https://dms-api.example;");
      expect(conf).toContain('add_header Content-Security-Policy "');
      expect(conf).toContain("require-trusted-types-for 'script'");
    }
    expect(upload).toContain("frame-ancestors 'self' https://dms.example;");
    expect(upload).not.toContain('X-Frame-Options');
  });

  it('T-61: upload.conf is the sandboxed set: sandbox CSP, connect-src none, explicit origins, no report-uri, no referrer, no store', () => {
    const upload = headersOf(render(DMS_ENV).upload);
    const csp = upload['Content-Security-Policy']!;
    expect(csp.startsWith("sandbox allow-scripts allow-forms; default-src 'none';")).toBe(true);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    for (const directive of ['script-src', 'style-src', 'font-src']) expect(csp).toContain(`${directive} 'self' https://dms.example;`);
    expect(csp).toContain("img-src 'self' https://dms.example data: blob:;");
    expect(csp).not.toMatch(/report-uri|report-to/);
    expect(upload['Referrer-Policy']).toBe('no-referrer');
    expect(upload['Cache-Control']).toBe('no-store');
    expect(upload['Reporting-Endpoints']).toBeUndefined();
    expect(upload['X-Frame-Options']).toBeUndefined();
  });

  it('FP_PUBLIC_ORIGINS defaults to VITE_FP_EMBED_PARENTS (the Docker build passes it empty)', () => {
    const upload = headersOf(render({ VITE_FP_EMBED_PARENTS: 'https://dms.example', FP_PUBLIC_ORIGINS: '' }).upload);
    expect(upload['Content-Security-Policy']).toContain("script-src 'self' https://dms.example;");
    const explicit = headersOf(render({ VITE_FP_EMBED_PARENTS: 'https://dms.example', FP_PUBLIC_ORIGINS: 'https://public.example' }).upload);
    expect(explicit['Content-Security-Policy']).toContain("script-src 'self' https://public.example;");
  });

  it("M2 legacy build: upload.conf is today's framable set (not sandboxed, no report-uri, no-store)", () => {
    const upload = headersOf(render({ ...DMS_ENV, VITE_FP_LEGACY_DESCRIPTOR: '1' }).upload);
    const csp = upload['Content-Security-Policy']!;
    expect(csp).not.toContain('sandbox');
    expect(csp).toContain("frame-ancestors 'self' https://dms.example;");
    expect(csp).not.toMatch(/report-uri|report-to/);
    expect(upload['X-Frame-Options']).toBeUndefined();
    expect(upload['Cache-Control']).toBe('no-store');
  });

  it('refuses to write a policy from a malformed origin', () => {
    expect(() => render({ VITE_FP_EMBED_PARENTS: '*' })).toThrow();
    expect(() => render({ VITE_FP_EMBED_PARENTS: 'https://dms.example', FP_PUBLIC_ORIGINS: 'not a url' })).toThrow();
  });
});

describe('deploy/nginx.conf.template', () => {
  it('substitutes only FP_WEB_ROOT and FP_HEADERS_DIR (the rest are nginx variables)', () => {
    expect([...new Set(template.match(/\$\{[A-Z_]+\}/g))].sort()).toEqual(['${FP_HEADERS_DIR}', '${FP_WEB_ROOT}']);
  });

  it('listens on 8080, serves /formplus/ with the SPA fallback and answers /formplus/healthz', () => {
    expect(template).toMatch(/listen 8080;/);
    expect(flat).toMatch(/location \/formplus\/ \{[^}]*try_files \$uri \/formplus\/index\.html;/s);
    expect(flat).toMatch(/location = \/formplus\/healthz \{[^}]*return 200/s);
  });

  it('gives every file-serving location its header include (nginx does not inherit add_header); only dms-upload gets the upload set, the full-page embeds their own', () => {
    const blocks = [...flat.matchAll(/location ([^{]+)\{([^}]*)\}/g)].map((m) => ({ at: m[1]!.trim(), body: m[2]! }));
    const serving = blocks.filter((b) => b.body.includes('try_files'));
    expect(serving.map((b) => b.at)).toEqual(['= /formplus/embed/dms-upload', '^~ /formplus/assets/', '^~ /formplus/embed/', '/formplus/', '= /moved/formbuilder.html']);
    for (const b of serving) expect(b.body, b.at).toMatch(/include @FP_HEADERS_DIR@\/(plain|embed-page|upload)\.conf;/);
    expect(serving.filter((b) => b.body.includes('/upload.conf')).map((b) => b.at)).toEqual(['= /formplus/embed/dms-upload']);
    expect(serving.filter((b) => b.body.includes('/embed-page.conf')).map((b) => b.at)).toEqual(['^~ /formplus/embed/']);
  });

  it('T-61: /formplus/embed/dms-upload serves its own entry (embed-upload.html), not the SPA, with the sandboxed set and no second Cache-Control', () => {
    const block = flat.match(/location = \/formplus\/embed\/dms-upload \{([^}]*)\}/s)![1]!;
    expect(block).toContain('include @FP_HEADERS_DIR@/upload.conf;');
    expect(block).toContain('try_files /formplus/embed-upload.html =404;');
    expect(block).not.toContain('index.html');
    expect(block).not.toMatch(/add_header Cache-Control/); // the set carries it: two Cache-Control headers would be sent
    const headers = effectiveHeaders('= /formplus/embed/dms-upload', DMS_ENV);
    expect(headers['Content-Security-Policy']).toMatch(/^sandbox allow-scripts allow-forms; /);
    expect(headers['Content-Security-Policy']).toContain("connect-src 'none'");
    expect(headers['Content-Security-Policy']).not.toMatch(/report-uri|report-to/);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Reporting-Endpoints']).toBeUndefined();
  });

  it('T-61: /formplus/assets/ answers Access-Control-Allow-Origin: * (the opaque-origin page loads its scripts, styles and fonts with Origin: null) and stays immutable', () => {
    const headers = effectiveHeaders('^~ /formplus/assets/', DMS_ENV);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    // Only the assets: a CORS header on a page or an API response would be a hole.
    expect(flat.match(/add_header Access-Control-Allow-Origin/g)).toHaveLength(1);
    expect(flat.match(/location \^~ \/formplus\/assets\/ \{[^}]*add_header Access-Control-Allow-Origin/s)).not.toBeNull();
    // `*` is only valid without credentials, which is what a module script fetch of a public file uses.
    expect(template).not.toContain('Access-Control-Allow-Credentials');
  });

  it('T-61: the full-page embeds (dms-master, dms-record) are never framed and send no report-uri', () => {
    const headers = effectiveHeaders('^~ /formplus/embed/', DMS_ENV);
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).not.toMatch(/report-uri|report-to|sandbox/);
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Reporting-Endpoints']).toBeUndefined();
    // The SPA behind them keeps its report endpoint.
    expect(effectiveHeaders('/formplus/', DMS_ENV)['Content-Security-Policy']).toContain('report-uri');
  });

  it('T-61: /formbuilder/sharemaster (the share token is in the query) is never logged; the redirect keeps the query', () => {
    expect(template).toMatch(/location = \/formbuilder\/sharemaster \{\s*access_log off;\s*return 301 \/sharemaster\$is_args\$args;/);
    expect(template).toMatch(/location = \/formbuilder\/sharemaster\/ \{\s*access_log off;\s*return 301 \/sharemaster\$is_args\$args;/);
  });

  it('T-61: the access log of /formplus/embed/* names no cookie, no authorization and no query string', () => {
    const format = template.match(/^log_format fp_embed (.+);$/m)?.[1];
    expect(format, 'log_format fp_embed').toBeDefined();
    const without = format!.replace('$request_method', '');
    for (const variable of ['$http_cookie', '$http_authorization', '$args', '$query_string', '$request_uri', '$request', '$is_args', '$http_referer', '$http_x_']) {
      expect(without, variable).not.toContain(variable);
    }
    expect(format).toContain('$uri');
    for (const at of ['= /formplus/embed/dms-upload', '^~ /formplus/embed/']) {
      expect(flat.match(new RegExp(`location ${escape(at)} \\{[^}]*access_log /dev/stdout fp_embed;`, 's')), at).not.toBeNull();
    }
    // The default formats of the image are not used anywhere in this file.
    expect(template).not.toMatch(/access_log [^;]*\bmain\b/);
    expect(template).not.toMatch(/access_log [^;]*\bcombined\b/);
  });

  it('/formbuilder/sharemaster -> 301 /sharemaster with the query kept; every other /formbuilder path -> 410 and the static moved page', () => {
    expect(template).toMatch(/location = \/formbuilder\/sharemaster \{[^}]*return 301 \/sharemaster\$is_args\$args;/);
    expect(template).toMatch(/location \^~ \/formbuilder\/ \{\s*return 410;/);
    expect(template).toMatch(/location = \/formbuilder \{\s*return 410;/);
    expect(template).toContain('error_page 410 /moved/formbuilder.html;');
    expect(read('deploy/moved.html')).not.toMatch(/<script|style=|<style/i);
  });
});

describe('Dockerfile', () => {
  it('builds @form/builder with pnpm and the VITE_* build args, and serves it from nginx-unprivileged on 8080', () => {
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --filter @form/builder...');
    expect(dockerfile).toContain('pnpm --filter @form/builder build');
    // The signed system formpack is built before the builder that imports it.
    expect(dockerfile.indexOf('pnpm --filter @form/templates build')).toBeGreaterThan(-1);
    expect(dockerfile.indexOf('pnpm --filter @form/templates build')).toBeLessThan(dockerfile.indexOf('pnpm --filter @form/builder build'));
    for (const arg of ['VITE_BASE=/formplus/', 'VITE_API_URL', 'VITE_FP_DMS_API_BASE', 'VITE_FP_DMS_API_ORIGINS', 'VITE_FP_EMBED_PARENTS', 'VITE_FP_RETURN_ORIGINS']) {
      expect(dockerfile).toContain(`ARG ${arg}`);
    }
    expect(dockerfile).toContain('VITE_FP_RETURN_ORIGINS=$VITE_FP_RETURN_ORIGINS');
    expect(dockerfile).toContain('FROM nginxinc/nginx-unprivileged:');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('/etc/nginx/templates/default.conf.template');
    expect(dockerfile).toContain('node apps/builder/security/render-nginx.ts');
  });

  it('T-61: VITE_FP_LEGACY_DESCRIPTOR is a build arg that defaults to empty (the default build is fp-bridge/2 only); FP_PUBLIC_ORIGINS is an arg and both reach the build', () => {
    expect(dockerfile).toMatch(/^ARG VITE_FP_LEGACY_DESCRIPTOR=$/m);
    expect(dockerfile).toMatch(/^ARG FP_PUBLIC_ORIGINS=$/m);
    expect(dockerfile).toContain('VITE_FP_LEGACY_DESCRIPTOR=$VITE_FP_LEGACY_DESCRIPTOR');
    expect(dockerfile).toContain('FP_PUBLIC_ORIGINS=$FP_PUBLIC_ORIGINS');
    // Both args are declared before the RUN that builds, so the build and render-nginx see them.
    const build = dockerfile.indexOf('pnpm --filter @form/builder build');
    expect(dockerfile.indexOf('ARG VITE_FP_LEGACY_DESCRIPTOR')).toBeLessThan(build);
    expect(dockerfile.indexOf('ARG FP_PUBLIC_ORIGINS')).toBeLessThan(build);
  });

  it('carries no secret-looking build arg', () => {
    expect(dockerfile).not.toMatch(/ARG [A-Z_]*(SECRET|TOKEN|PASSWORD|KEY)/);
  });
});
