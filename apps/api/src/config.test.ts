import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from './authz/roles.ts';
import { parseConfig } from './config.ts';

const base = {
  DEPLOYMENT_MODE: 'onprem',
  DATABASE_URL: 'postgres://fr_app:pw@db:5432/form',
  AUTH_SECRET: 'A'.repeat(43),
  KMS_KEYFILE_PATH: '/run/secrets/form-master.key',
  PUBLIC_BUILDER_URL: 'https://app.form.example',
  SMTP_URL: 'smtp://relay:25',
  PRIVACY_CONTACT_EMAIL: 'privacy@form.example',
};

describe('parseConfig', () => {
  it('applies defaults', () => {
    const r = parseConfig(base);
    expect(r.ok && r.config).toMatchObject({
      env: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      database: { url: base.DATABASE_URL, poolMax: 20, auditPoolMax: 2 },
      corsOrigins: ['https://app.form.example'],
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
      TRUST_PROXY: '1',
      DATABASE_POOL_MAX: '',
    });
    expect(r.ok && r.config).toMatchObject({
      corsOrigins: ['https://app.form.example'],
      ntp: { servers: ['time.nplindia.org', 'samay1.nic.in'] },
      telemetry: { endpoint: 'http://otel:4318', sampleRatio: 1 },
      trustProxy: 1,
      database: { poolMax: 20 },
    });
  });

  it('trusts a hop count or named proxies, never every hop', () => {
    const trust = (v: string) => {
      const r = parseConfig({ ...base, TRUST_PROXY: v });
      return r.ok ? r.config.trustProxy : r.errors;
    };
    expect(trust('false')).toBe(false);
    expect(trust('2')).toBe(2);
    expect(trust('10.0.0.0/8, 192.168.1.4,loopback,fd00::/8')).toEqual(['10.0.0.0/8', '192.168.1.4', 'loopback', 'fd00::/8']);
    for (const bad of ['true', 'yes', '10.0.0.0/33', 'proxy.local', '10.0.0.1/8/1']) expect(trust(bad)).toEqual([expect.stringMatching(/^TRUST_PROXY: expected false, a hop count/)]);
  });
});

describe('auth settings (WP-1.01)', () => {
  const google = { OIDC_GOOGLE_CLIENT_ID: 'id', OIDC_GOOGLE_CLIENT_SECRET: 'secret' };

  it('needs the auth secret, the keyfile, the builder URL and SMTP in production', () => {
    const r = parseConfig({ DEPLOYMENT_MODE: 'onprem', DATABASE_URL: base.DATABASE_URL });
    expect(r.ok ? [] : r.errors).toEqual([
      'AUTH_SECRET: is required in production',
      'KMS_KEYFILE_PATH: is required in production: TOTP secrets are encrypted',
      'PUBLIC_BUILDER_URL: is required in production: sign-in emails link to the builder',
      'SMTP_URL: is required in production with MAILER_DRIVER=smtp',
      'PRIVACY_CONTACT_EMAIL: is required in production: the privacy notice names it as the contact for builder users',
    ]);
    expect(parseConfig({ ...base, SMTP_URL: '', MAILER_DRIVER: 'log' }).ok).toBe(true);
    const dev = parseConfig({ DEPLOYMENT_MODE: 'onprem', DATABASE_URL: base.DATABASE_URL, NODE_ENV: 'development' });
    expect(dev.ok && dev.config.auth.secret.byteLength).toBe(32);
    expect(dev.ok && dev.config.notices).toContain('AUTH_SECRET is not set: a random secret is used for this process');
    expect(dev.ok && dev.config.auth).toMatchObject({ builderUrl: 'http://localhost:5173', apiUrl: 'http://127.0.0.1:8080', oidcAllowInsecure: true });
  });

  it('names the privacy contact of the platform notice (CMP-21)', () => {
    const r = parseConfig({ ...base, PRIVACY_FIDUCIARY_NAME: 'Acme Hospital', PRIVACY_CONTACT_NAME: 'Grievance Officer' });
    expect(r.ok && r.config.privacy).toEqual({ fiduciaryName: 'Acme Hospital', contactEmail: 'privacy@form.example', contactName: 'Grievance Officer' });
    const dev = parseConfig({ DEPLOYMENT_MODE: 'onprem', DATABASE_URL: base.DATABASE_URL, NODE_ENV: 'development' });
    expect(dev.ok && dev.config.privacy).toEqual({ fiduciaryName: 'fORM-', contactEmail: 'privacy@form.local', contactName: null });
    expect(parseConfig({ ...base, PRIVACY_CONTACT_EMAIL: 'not an address' }).ok).toBe(false);
  });

  it('refuses a short or malformed auth secret and reads it from a file', () => {
    expect(parseConfig({ ...base, AUTH_SECRET: 'short' }).ok).toBe(false);
    expect(parseConfig({ ...base, AUTH_SECRET: `${'A'.repeat(42)}!` }).ok).toBe(false);
    const r = parseConfig({ ...base, AUTH_SECRET: '', AUTH_SECRET_FILE: '/run/secrets/auth' }, () => `${'B'.repeat(43)}\n`);
    expect(r.ok && r.config.auth.secret).toEqual(new Uint8Array(Buffer.from('B'.repeat(43), 'base64url')));
  });

  it('offers Google and Microsoft on SaaS only, so never air-gapped', () => {
    const saas = parseConfig({ ...base, DEPLOYMENT_MODE: 'saas', ...google });
    expect(saas.ok && saas.config.auth.oidc).toEqual({ google: { issuer: 'https://accounts.google.com', clientId: 'id', clientSecret: 'secret' } });
    for (const egress of ['allowlist', 'none']) {
      const onprem = parseConfig({ ...base, EGRESS_POLICY: egress, ...google });
      expect(onprem.ok && onprem.config.auth.oidc).toEqual({});
      expect(onprem.ok && onprem.config.notices).toEqual(['OIDC_GOOGLE_* is ignored: Google and Microsoft sign-in are SaaS only (ADR-0017)']);
    }
  });

  it('checks the OIDC settings', () => {
    const half = parseConfig({ ...base, DEPLOYMENT_MODE: 'saas', OIDC_MICROSOFT_CLIENT_ID: 'id' });
    expect(half.ok ? [] : half.errors).toEqual(['OIDC_MICROSOFT_CLIENT_SECRET: goes together with OIDC_MICROSOFT_CLIENT_ID']);
    const http = parseConfig({ ...base, DEPLOYMENT_MODE: 'saas', ...google, OIDC_GOOGLE_ISSUER: 'http://idp.test' });
    expect(http.ok ? [] : http.errors).toEqual(['OIDC_GOOGLE_ISSUER: must be https in production']);
    const ms = parseConfig({ ...base, DEPLOYMENT_MODE: 'saas', OIDC_MICROSOFT_CLIENT_ID: 'm', OIDC_MICROSOFT_CLIENT_SECRET_FILE: '/s' }, () => 'ms-secret\n');
    expect(ms.ok && ms.config.auth.oidc.microsoft).toEqual({ issuer: 'https://login.microsoftonline.com/common/v2.0', clientId: 'm', clientSecret: 'ms-secret' });
  });

  it('turns the HIBP check on for SaaS with open egress only, and never when air-gapped', () => {
    const breach = (env: Record<string, string>) => {
      const r = parseConfig({ ...base, ...env });
      return r.ok ? r.config.auth.breachCheck : r.errors;
    };
    expect(breach({ DEPLOYMENT_MODE: 'saas' })).toBe('hibp');
    expect(breach({ DEPLOYMENT_MODE: 'saas', PASSWORD_BREACH_CHECK: 'off' })).toBe('off');
    expect(breach({})).toBe('off');
    expect(breach({ PASSWORD_BREACH_CHECK: 'hibp' })).toBe('hibp');
    expect(breach({ EGRESS_POLICY: 'none', PASSWORD_BREACH_CHECK: 'hibp' })).toBe('off');
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
