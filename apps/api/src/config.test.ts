import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from './authz/roles.ts';
import { parseConfig } from './config.ts';

const base = { DEPLOYMENT_MODE: 'onprem', DATABASE_URL: 'postgres://fr_app:pw@db:5432/form' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const r = parseConfig(base);
    expect(r.ok && r.config).toMatchObject({
      env: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      database: { url: base.DATABASE_URL, poolMax: 20, auditPoolMax: 2 },
      corsOrigins: [],
      trustProxy: false,
      telemetry: { endpoint: undefined, serviceName: 'fr-api', sampleRatio: 0.1 },
      ntp: { servers: [], maxOffsetMs: 1000 },
      authDevHeaders: false,
      edition: { deploymentMode: 'onprem', egressPolicy: 'allowlist' },
    });
  });

  it('reports every error at once, including the edition', () => {
    const r = parseConfig({ DEPLOYMENT_MODE: 'cloud', PORT: 'x', DATABASE_URL: 'mysql://x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/PORT/);
    expect(r.errors.join('\n')).toMatch(/DATABASE_URL: expected a postgres/);
    expect(r.errors.join('\n')).toMatch(/DEPLOYMENT_MODE/);
  });

  it('starts in every edition', () => {
    for (const [mode, egress, airGapped] of [
      ['saas', '', false],
      ['onprem', '', false],
      ['onprem', 'none', true],
    ] as const) {
      const r = parseConfig({ ...base, DEPLOYMENT_MODE: mode, EGRESS_POLICY: egress });
      expect(r.ok && r.config.edition.airGapped, `${mode}/${egress}`).toBe(airGapped);
    }
  });

  it('refuses dev header auth in production', () => {
    const r = parseConfig({ ...base, AUTH_DEV_HEADERS: 'true' });
    expect(r.ok ? [] : r.errors).toEqual(['AUTH_DEV_HEADERS: is refused when NODE_ENV=production']);
    const dev = parseConfig({ ...base, AUTH_DEV_HEADERS: '1', NODE_ENV: 'development' });
    expect(dev.ok && dev.config.authDevHeaders).toBe(true);
  });

  it('reads DATABASE_URL_FILE over DATABASE_URL and reports unreadable files', () => {
    const files: Record<string, string> = { '/run/secrets/db': 'postgres://fr_app:secret@db/form\n' };
    const read = (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    };
    const r = parseConfig({ ...base, DATABASE_URL_FILE: '/run/secrets/db' }, read);
    expect(r.ok && r.config.database.url).toBe('postgres://fr_app:secret@db/form');
    const missing = parseConfig({ ...base, DATABASE_URL_FILE: '/nope' }, read);
    expect(missing.ok ? [] : missing.errors).toEqual(['DATABASE_URL_FILE: cannot read /nope (ENOENT)']);
  });

  it('derives the CORS origin, NTP servers and telemetry settings', () => {
    const r = parseConfig({
      ...base,
      PUBLIC_BUILDER_URL: 'https://app.form.example/builder',
      NTP_SERVERS: 'time.nplindia.org, samay1.nic.in,',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      OTEL_TRACES_SAMPLER_ARG: '1',
      TRUST_PROXY: 'true',
      DATABASE_POOL_MAX: '',
    });
    expect(r.ok && r.config).toMatchObject({
      corsOrigins: ['https://app.form.example'],
      ntp: { servers: ['time.nplindia.org', 'samay1.nic.in'] },
      telemetry: { endpoint: 'http://otel:4318', sampleRatio: 1 },
      trustProxy: true,
      database: { poolMax: 20 },
    });
  });
});

describe('ROLE_PERMISSIONS', () => {
  it('follows the permission table', () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(PERMISSIONS);
    expect(ROLE_PERMISSIONS.admin).not.toContain('billing.manage');
    expect(ROLE_PERMISSIONS.editor).toEqual(expect.arrayContaining(['forms.publish', 'data.route', 'submissions.export']));
    expect(ROLE_PERMISSIONS.editor).not.toContain('members.manage');
    expect(ROLE_PERMISSIONS.creator).not.toContain('submissions.read');
    expect(ROLE_PERMISSIONS.creator).not.toContain('data.route');
    expect(ROLE_PERMISSIONS.viewer).toEqual(['forms.read', 'submissions.read']);
  });
});
