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

let out: string | undefined;
afterEach(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  out = undefined;
});

describe('security/render-nginx.ts', () => {
  const render = (env: Record<string, string>) => {
    out = mkdtempSync(path.join(tmpdir(), 'fp-headers-'));
    execFileSync(process.execPath, [path.join(here, 'render-nginx.ts'), out], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
    return { plain: readFileSync(path.join(out, 'plain.conf'), 'utf8'), embed: readFileSync(path.join(out, 'embed.conf'), 'utf8') };
  };

  it('writes plain.conf (no framing) and embed.conf (framable by VITE_FP_EMBED_PARENTS), both allowing the DMS API origins', () => {
    const { plain, embed } = render({ VITE_FP_DMS_API_ORIGINS: 'https://dms-api.example/api', VITE_FP_EMBED_PARENTS: 'https://dms.example' });
    expect(plain).toContain("frame-ancestors 'none'");
    expect(plain).toContain('add_header X-Frame-Options "DENY" always;');
    expect(embed).toContain("frame-ancestors 'self' https://dms.example;");
    expect(embed).not.toContain('X-Frame-Options');
    for (const conf of [plain, embed]) {
      expect(conf).toContain("connect-src 'self' https://dms-api.example;");
      expect(conf).toContain('add_header Content-Security-Policy "');
      expect(conf).toContain("require-trusted-types-for 'script'");
    }
  });

  it('refuses to write a policy from a malformed origin', () => {
    expect(() => render({ VITE_FP_EMBED_PARENTS: '*' })).toThrow();
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

  it('gives every file-serving location its header include (nginx does not inherit add_header); only dms-upload gets the framable set', () => {
    const blocks = [...flat.matchAll(/location ([^{]+)\{([^}]*)\}/g)].map((m) => ({ at: m[1]!.trim(), body: m[2]! }));
    const serving = blocks.filter((b) => b.body.includes('try_files'));
    expect(serving.map((b) => b.at)).toEqual(['= /formplus/embed/dms-upload', '^~ /formplus/assets/', '/formplus/', '= /moved/formbuilder.html']);
    for (const b of serving) expect(b.body, b.at).toMatch(/include @FP_HEADERS_DIR@\/(plain|embed)\.conf;/);
    expect(serving.filter((b) => b.body.includes('/embed.conf')).map((b) => b.at)).toEqual(['= /formplus/embed/dms-upload']);
  });

  it('/formbuilder/sharemaster -> 301 /sharemaster with the query kept; every other /formbuilder path -> 410 and the static moved page', () => {
    expect(template).toMatch(/location = \/formbuilder\/sharemaster \{\s*return 301 \/sharemaster\$is_args\$args;/);
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
    for (const arg of ['VITE_BASE=/formplus/', 'VITE_API_URL', 'VITE_FP_DMS_API_BASE', 'VITE_FP_DMS_API_ORIGINS', 'VITE_FP_EMBED_PARENTS']) expect(dockerfile).toContain(`ARG ${arg}`);
    expect(dockerfile).toContain('FROM nginxinc/nginx-unprivileged:');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('/etc/nginx/templates/default.conf.template');
    expect(dockerfile).toContain('node apps/builder/security/render-nginx.ts');
  });

  it('carries no secret-looking build arg', () => {
    expect(dockerfile).not.toMatch(/ARG [A-Z_]*(SECRET|TOKEN|PASSWORD|KEY)/);
  });
});
