import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db, DbHandle } from '@form/db';
import type { ClockStatus } from '@form/observability';
import { PortError, type EgressGuard, type KeyContext, type KeyProvider, type Mailer, type OrgSecrets, type Queue, type Storage } from '@form/ports';
import { collect, coverage, ISOLATION_CASES, type CollectedRoute } from '../test/isolation-cases/index.ts';
import { buildApp, BODY_LIMIT, type AppDeps } from './app.ts';
import { clientInfo } from './auth.ts';
import { parseConfig, type ApiConfig } from './config.ts';
import { ProblemError } from './errors.ts';
import { createOrgMailer, type OrgSmtpSenders } from './org-mailer.ts';

/**
 * The stub modules of the approvals, notifications, webhooks and exports work (WP-2.33, WP-1.16..1.18) wrapped so a test
 * sees that `buildApp` registers each one and with which deps. They call through, so the app is the real one.
 */
const registered = vi.hoisted(() => ({ calls: [] as Array<{ module: string; deps: Record<string, unknown> }> }));
vi.mock('./modules/reviews/index.ts', async (original) => {
  const m = await original<typeof import('./modules/reviews/index.ts')>();
  return { ...m, registerReviewModule: ((app, deps) => (registered.calls.push({ module: 'reviews', deps: { ...deps } }), m.registerReviewModule(app, deps))) as typeof m.registerReviewModule };
});
vi.mock('./routes/email-senders.ts', async (original) => {
  const m = await original<typeof import('./routes/email-senders.ts')>();
  return { ...m, emailSenderRoutes: ((app, deps) => (registered.calls.push({ module: 'email-senders', deps: { ...deps } }), m.emailSenderRoutes(app, deps))) as typeof m.emailSenderRoutes };
});
vi.mock('./routes/notifications.ts', async (original) => {
  const m = await original<typeof import('./routes/notifications.ts')>();
  return { ...m, notificationRoutes: ((app, deps) => (registered.calls.push({ module: 'notifications', deps: { ...deps } }), m.notificationRoutes(app, deps))) as typeof m.notificationRoutes };
});
vi.mock('./routes/webhooks.ts', async (original) => {
  const m = await original<typeof import('./routes/webhooks.ts')>();
  return { ...m, webhookRoutes: ((app, deps) => (registered.calls.push({ module: 'webhooks', deps: { ...deps } }), m.webhookRoutes(app, deps))) as typeof m.webhookRoutes };
});
vi.mock('./routes/exports.ts', async (original) => {
  const m = await original<typeof import('./routes/exports.ts')>();
  return { ...m, exportRoutes: ((app, deps) => (registered.calls.push({ module: 'exports', deps: { ...deps } }), m.exportRoutes(app, deps))) as typeof m.exportRoutes };
});

function config(env: Record<string, string> = {}): ApiConfig {
  const r = parseConfig({
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: 'postgres://fr_app:x@127.0.0.1:1/form',
    LOG_LEVEL: 'info',
    PUBLIC_BUILDER_URL: 'https://app.form.test',
    AUTH_SECRET: 'A'.repeat(43),
    KMS_KEYFILE_PATH: '/run/secrets/form-master.key',
    MAILER_DRIVER: 'log',
    PRIVACY_CONTACT_EMAIL: 'privacy@form.test',
    ...env,
  });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.config;
}

function fakeDb(ping: () => Promise<void>): DbHandle {
  return { db: {} as Db, pool: { query: ping } as unknown as pg.Pool, close: async () => {} };
}

const apps: FastifyInstance[] = [];
async function app(cfg = config(), deps: AppDeps = {}) {
  const lines: Record<string, unknown>[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  const a = await buildApp(cfg, { logStream, ...deps });
  apps.push(a);
  return { app: a, lines };
}

/*
 * The first buildApp() of a run loads Fastify and its plugins, which takes seconds when every package's tests run at once.
 * It is paid here, in a hook with the longer `hookTimeout` of vitest.config.ts, so the tests below keep the default timeout.
 */
beforeAll(async () => {
  await (await app()).app.ready();
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const clockOk = async (): Promise<ClockStatus> => ({ status: 'ok', server: 'ntp.test', offsetMs: 3 });

describe('health', () => {
  it('livez answers and carries a request id', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await a.inject({ url: '/livez', headers: { 'x-request-id': 'req-123' } });
    expect(echoed.headers['x-request-id']).toBe('req-123');
    const replaced = await a.inject({ url: '/livez', headers: { 'x-request-id': 'bad id\nwith newline' } });
    // Replaced by a fresh uuid (a uuid is hex, so it may contain "bad": check the shape, not the absence of the text).
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('readyz is ok when the database answers and the clock is in range or unchecked', async () => {
    const { app: a } = await app(config(), { db: fakeDb(async () => {}), clock: clockOk });
    const res = await a.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: { status: 'ok' }, clock: { status: 'ok', server: 'ntp.test', offsetMs: 3 } } });
    const { app: b } = await app(config(), { db: fakeDb(async () => {}) });
    expect((await b.inject({ url: '/readyz' })).json()).toMatchObject({ status: 'ok', checks: { clock: { status: 'skipped' } } });
  });

  it('readyz is unavailable when the database is down or the clock drifts', async () => {
    const { app: a } = await app(config(), { clock: async () => ({ status: 'failed', reason: 'clock offset 1500 ms exceeds 1000 ms', offsetMs: 1500 }) });
    const res = await a.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'unavailable',
      checks: { db: { status: 'failed', detail: 'database unreachable' }, clock: { status: 'failed', detail: 'clock offset 1500 ms exceeds 1000 ms', offsetMs: 1500 } },
    });
  });

  it('readyz times out a hanging database', async () => {
    const { app: a } = await app(config(), { db: fakeDb(() => new Promise(() => {})), clock: async () => Promise.reject(new Error('ntp down')) });
    const res = await a.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { db: { status: 'failed' }, clock: { status: 'failed', detail: 'ntp down' } } });
  }, 10_000);
});

describe('problem+json', () => {
  it('answers unknown routes with NOT_FOUND and a scrubbed instance', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/v1/nope?email=a@b.in&lang=hi' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(res.json()).toEqual({
      type: 'urn:form:problem:not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'No route for GET /v1/nope',
      instance: '/v1/nope?lang=hi',
      requestId: res.headers['x-request-id'],
    });
  });

  it('reports validation errors with paths', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/v1/forms?limit=999&lifecycle=gone' });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; errors: { path: string }[] }>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors.map((e) => e.path).sort()).toEqual(['querystring/lifecycle', 'querystring/limit']);
  });

  it('hides internal error details and logs them', async () => {
    const { app: a, lines } = await app();
    a.get('/boom', { config: { auth: 'none' } }, async () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const res = await a.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL', title: 'Internal error' });
    expect(res.body).not.toContain('10.0.0.5');
    expect(lines.some((l) => l.msg === 'request failed' && JSON.stringify(l).includes('10.0.0.5'))).toBe(true);
  });

  it('never logs the bound parameters of a failed query, and answers 400 for text the database cannot store', async () => {
    const { app: a, lines } = await app();
    const failed = (code: string, message: string) => () =>
      new DrizzleQueryError('insert into "form_submissions" ("answers") values ($1)', ['{"pan":"ABCDE1234F-SECRET-PII"}'], Object.assign(new Error(message), { severity: 'ERROR', code, where: 'JSON data: ABCDE1234F-SECRET-PII' }));
    a.get('/nul', { config: { auth: 'none' } }, async () => {
      throw failed('22P05', 'unsupported Unicode escape sequence')();
    });
    a.get('/broken', { config: { auth: 'none' } }, async () => {
      throw failed('XX000', 'something broke')();
    });
    const nul = await a.inject({ url: '/nul' });
    expect(nul.statusCode).toBe(400);
    expect(nul.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const broken = await a.inject({ url: '/broken' });
    expect(broken.statusCode).toBe(500);
    expect(JSON.stringify(lines)).not.toMatch(/SECRET-PII|ABCDE1234F/);
    // What an operator needs is logged: the SQLSTATE and the SQL text with its placeholders.
    expect(lines.find((l) => l.msg === 'request failed')).toMatchObject({ err: { code: 'XX000', query: expect.stringContaining('$1') } });
    expect(lines.find((l) => l.msg === 'the database refused text it cannot store')).toMatchObject({ err: { code: '22P05' } });
  });

  it('treats a database that cannot be reached like any other failure: a plain 500, no detail, and an audit record', async () => {
    const written: Array<Record<string, unknown>> = [];
    const dialect = new PgDialect();
    const tx = {
      execute: async (q: SQL) => {
        const { sql, params } = dialect.sqlToQuery(q);
        if (sql.startsWith('insert into audit_pending')) written.push(JSON.parse(params[1] as string) as Record<string, unknown>);
      },
    };
    const auditDb = { db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as unknown as Db, pool: {} as pg.Pool, close: async () => {} };
    const { app: a } = await app(config(), { auditDb });
    const messages = ['connect ECONNREFUSED 10.0.0.5:5432', 'timeout exceeded when trying to connect', 'Connection terminated unexpectedly'];
    messages.forEach((message, i) => {
      a.get(`/db-down-${i}`, { config: { auth: 'none' } }, async () => {
        throw new Error(message);
      });
    });
    for (const i of messages.keys()) {
      const res = await a.inject({ url: `/db-down-${i}` });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'INTERNAL', title: 'Internal error' });
      expect(res.json()).not.toHaveProperty('detail');
      expect(res.body).not.toMatch(/database|10\.0\.0\.5|Publish|timeout/i);
    }
    expect(written.map((e) => [e['action'], e['reason']])).toEqual([
      ['request.failed', 'INTERNAL'],
      ['request.failed', 'INTERNAL'],
      ['request.failed', 'INTERNAL'],
    ]);
  });

  it('audits 5xx and 403 responses on the audit pool, and answers even when that write fails', async () => {
    const written: Array<{ orgKey: string; event: Record<string, unknown> }> = [];
    const settings: unknown[] = [];
    const dialect = new PgDialect();
    const tx = {
      execute: async (q: SQL) => {
        const { sql, params } = dialect.sqlToQuery(q);
        if (sql.startsWith('insert into audit_pending')) written.push({ orgKey: params[0] as string, event: JSON.parse(params[1] as string) as Record<string, unknown> });
        else settings.push(q);
      },
    };
    const auditDb = { db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as unknown as Db, pool: {} as pg.Pool, close: async () => {} };
    const { app: a, lines } = await app(config(), { auditDb });
    a.get('/boom', { config: { auth: 'none' } }, async () => {
      throw new Error('secret detail');
    });
    a.get('/nope', { config: { auth: 'none' } }, async () => {
      throw new ProblemError('FORBIDDEN', 'not yours');
    });
    expect((await a.inject({ url: '/boom' })).statusCode).toBe(500);
    expect((await a.inject({ url: '/nope', headers: { 'x-request-id': 'r-403' } })).statusCode).toBe(403);
    expect(written).toEqual([
      {
        orgKey: '00000000-0000-0000-0000-000000000000',
        event: expect.objectContaining({ actorKind: 'none', action: 'request.failed', resourceId: 'GET /boom', outcome: 'error', reason: 'INTERNAL', metadata: { status: 500, code: 'INTERNAL' } }),
      },
      {
        orgKey: '00000000-0000-0000-0000-000000000000',
        event: expect.objectContaining({ action: 'request.authorize', outcome: 'denied', reason: 'forbidden', requestId: 'r-403' }),
      },
    ]);
    expect(JSON.stringify(written)).not.toContain('secret detail');
    expect(settings).toHaveLength(2);

    const broken = { db: { transaction: async () => Promise.reject(new Error('audit pool exhausted')) } as unknown as Db, pool: {} as pg.Pool, close: async () => {} };
    const { app: b, lines: bLines } = await app(config(), { auditDb: broken });
    b.get('/nope', { config: { auth: 'none' } }, async () => {
      throw new ProblemError('FORBIDDEN');
    });
    expect((await b.inject({ url: '/nope' })).statusCode).toBe(403);
    expect(bLines.some((l) => l.msg === 'audit record of a refused or failed request was not written')).toBe(true);
    expect(lines.some((l) => l.msg === 'audit record of a refused or failed request was not written')).toBe(false);
  });

  it('maps body limits to PAYLOAD_TOO_LARGE', async () => {
    const { app: a } = await app();
    a.post('/echo', { config: { auth: 'none' } }, async (req) => req.body);
    const res = await a.inject({ method: 'POST', url: '/echo', payload: { big: 'x'.repeat(BODY_LIMIT) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('default deny', () => {
  it('treats a route with no auth setting as a user route: no session, no answer', async () => {
    const { app: a } = await app();
    a.get('/forgotten', async () => ({ secret: 'patient list' }));
    a.get('/forgotten-perm', { config: { perm: 'forms.read' } }, async () => ({ secret: 'patient list' }));
    a.get('/announced', { config: { auth: 'none' } }, async () => ({ ok: true }));
    for (const url of ['/forgotten', '/forgotten-perm']) {
      const res = await a.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(res.body).not.toContain('patient list');
    }
    // A route that says it is public is, and an address that matches no route is still a plain 404.
    expect((await a.inject({ url: '/announced' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/v1/nothing-here' })).statusCode).toBe(404);
  });
});

describe('authentication stub', () => {
  it('answers 401 on user routes when dev headers are off', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/v1/forms', headers: { 'x-fr-dev-user': '01970000-0000-7000-8000-000000000002' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('checks the dev headers before touching the database', async () => {
    const { app: a } = await app(config({ NODE_ENV: 'development', AUTH_DEV_HEADERS: 'true' }));
    expect((await a.inject({ url: '/v1/forms', headers: { 'x-fr-dev-user': 'admin' } })).json()).toMatchObject({ status: 401 });
    expect(
      (await a.inject({ url: '/v1/forms', headers: { 'x-fr-dev-user': '01970000-0000-7000-8000-000000000002' } })).json(),
    ).toMatchObject({ status: 400, detail: 'x-fr-org must be an org id' });
  });
});

describe('security headers, CORS and logs', () => {
  it('sets strict headers for a JSON API', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/livez' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('allows the builder origin only', async () => {
    const { app: a } = await app();
    const preflight = (origin: string) =>
      a.inject({ method: 'OPTIONS', url: '/v1/forms', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-fr-org' } });
    const ok = await preflight('https://app.form.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.form.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers['access-control-allow-headers'])).not.toContain('x-fr-dev-user');
    const evil = await preflight('https://evil.test');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the builder origin read only the request id, the etag and the file name of a response', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/livez', headers: { origin: 'https://app.form.test' } });
    expect(res.headers['access-control-expose-headers']).toBe('x-request-id, etag, content-disposition');
  });

  it('keys the client on the hop the trusted proxy added, not a client-chosen X-Forwarded-For', async () => {
    const cfg = config({ TRUST_PROXY: '1' });
    const { app: a } = await app(cfg);
    const seen: string[] = [];
    a.addHook('onRequest', async (request) => {
      seen.push(`${request.ip} ${Buffer.from(clientInfo(request, cfg.auth.secret, new Date('2026-10-19T00:00:00Z')).ipHash).toString('hex')}`);
    });
    for (const spoofed of ['198.51.100.1', '198.51.100.2, 192.0.2.9']) {
      await a.inject({ url: '/livez', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': `${spoofed}, 203.0.113.7` } });
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^203\.0\.113\.7 [0-9a-f]+$/);
    expect(seen[1]).toBe(seen[0]);
  });

  it('logs requests without query values or credentials', async () => {
    const { app: a, lines } = await app();
    await a.inject({ url: '/livez?email=asha@example.in&lang=hi&utm_source=x', headers: { authorization: 'Bearer fr_live_secret', cookie: '__Host-fr_sess=s' } });
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/asha@example\.in|fr_live_secret|__Host-fr_sess/);
    const incoming = lines.find((l) => l.msg === 'incoming request') as { req: { url: string }; requestId: string } | undefined;
    expect(incoming?.req.url).toBe('/livez?lang=hi&utm_source');
    expect(incoming?.requestId).toBeDefined();
  });
});

describe('edition', () => {
  it('serves the edition summary without a session and without the allowlist', async () => {
    const { app: a } = await app(config({ EGRESS_POLICY: 'none', EGRESS_ALLOWLIST: 'smtp.corp.local' }));
    const res = await a.inject({ url: '/v1/meta/edition' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toEqual({
      deploymentMode: 'onprem',
      egressPolicy: 'none',
      airGapped: true,
      captcha: { default: 'proof_of_work', thirdParty: [] },
      thirdPartyAnalytics: [],
      integrations: [],
      payments: [],
      guardianVerifiers: ['existing_account', 'manual_review'],
    });
    expect(res.body).not.toContain('smtp.corp.local');
    const saas = await (await app(config({ DEPLOYMENT_MODE: 'saas' }))).app.inject({ url: '/v1/meta/edition' });
    expect(saas.json()).toMatchObject({ deploymentMode: 'saas', egressPolicy: 'open', airGapped: false, payments: ['stripe', 'razorpay'] });
  });
});

describe('CSP violation reports', () => {
  const legacy = {
    'csp-report': {
      'document-uri': 'https://app.form.test/builder/abc?email=asha@example.in',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.test/x.js?token=secret',
      'source-file': 'https://app.form.test/assets/index.js',
      'line-number': 12,
      disposition: 'enforce',
      'script-sample': 'alert(document.cookie)',
    },
  };
  const batch = [
    {
      type: 'csp-violation',
      age: 1,
      url: 'https://app.form.test/forms',
      body: { documentURL: 'https://app.form.test/forms', effectiveDirective: 'require-trusted-types-for', blockedURL: 'trusted-types-sink', disposition: 'report', sample: 'Element insertAdjacentHTML|<img src=x>' },
    },
    { type: 'deprecation', body: { id: 'x' } },
  ];

  it('accepts both formats and logs scrubbed violations without samples', async () => {
    const { app: a, lines } = await app();
    const one = await a.inject({ method: 'POST', url: '/v1/csp-reports', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(legacy) });
    expect(one.statusCode).toBe(204);
    const two = await a.inject({ method: 'POST', url: '/v1/csp-reports', headers: { 'content-type': 'application/reports+json' }, payload: JSON.stringify(batch) });
    expect(two.statusCode).toBe(204);
    const logged = lines.filter((l) => l.msg === 'csp violation').map((l) => l.csp);
    expect(logged).toEqual([
      { directive: 'script-src-elem', disposition: 'enforce', blocked: 'https://evil.test', document: 'https://app.form.test/builder/abc', source: 'https://app.form.test/assets/index.js', line: 12 },
      { directive: 'require-trusted-types-for', disposition: 'report', blocked: 'trusted-types-sink', document: 'https://app.form.test/forms' },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/asha@example\.in|secret|alert\(|<img/);
  });

  it('rejects other bodies and oversized reports', async () => {
    const { app: a } = await app();
    const post = (payload: string, type = 'application/csp-report') => a.inject({ method: 'POST', url: '/v1/csp-reports', headers: { 'content-type': type }, payload });
    expect((await post('{"hello":1}')).statusCode).toBe(400);
    expect((await post('not json')).statusCode).toBe(400);
    expect((await post(JSON.stringify({ 'csp-report': { x: 'y'.repeat(70 * 1024) } }))).statusCode).toBe(413);
    expect((await post('{}', 'text/plain')).statusCode).toBe(400);
  });

  it('caps the log lines per minute and reports what it dropped', async () => {
    let t = 0;
    const { app: a, lines } = await app(config(), { cspReports: { now: () => t, maxPerMinute: 2 } });
    const send = () => a.inject({ method: 'POST', url: '/v1/csp-reports', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(legacy) });
    for (let i = 0; i < 5; i++) expect((await send()).statusCode).toBe(204);
    expect(lines.filter((l) => l.msg === 'csp violation')).toHaveLength(2);
    t = 60_000;
    await send();
    expect(lines.find((l) => l.msg === 'csp violation reports dropped')).toMatchObject({ dropped: 3 });
    expect(lines.filter((l) => l.msg === 'csp violation')).toHaveLength(3);
  });

  it('lets the builder origin send Reporting API batches cross-origin', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'OPTIONS',
      url: '/v1/csp-reports',
      headers: { origin: 'https://app.form.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.form.test');
  });
});

describe('stub route modules (approvals, notifications, webhooks, exports)', () => {
  const MODULES = ['reviews', 'email-senders', 'notifications', 'webhooks', 'exports'];

  it('registers every module once, with the db, the audit db, the secret and the clock, and the queue and org secrets the app was given', async () => {
    const queue = { send: async () => null } as unknown as Queue;
    const keys = { wrap: async () => ({ wrapped: new Uint8Array(), kekRef: 'k' }) } as unknown as KeyProvider;
    // A route seals secrets through this port, which the composition root builds from the KMS; the routes never import an adapter.
    const orgSecrets: OrgSecrets = { seal: async () => Promise.reject(new Error('not used')), open: async () => Promise.reject(new Error('not used')) };
    const cfg = config();
    registered.calls.length = 0;
    await app(cfg, { queue, keys, orgSecrets });
    expect(registered.calls.map((c) => c.module)).toEqual(MODULES);
    for (const { module, deps } of registered.calls) {
      expect(deps, module).toMatchObject({ db: expect.anything(), auditDb: expect.anything(), secret: cfg.auth.secret, now: expect.any(Function) });
      expect(deps['db'], module).not.toBe(deps['auditDb']);
    }
    const by = Object.fromEntries(registered.calls.map((c) => [c.module, c.deps]));
    // The queue is Core's producer, passed on as it is (never made again here).
    expect(by['reviews']).toMatchObject({ queue });
    expect(by['webhooks']).toMatchObject({ queue });
    expect(by['exports']).toMatchObject({ queue });
    // The two modules that store an org secret get the sealer, and never the raw KMS: they cannot wrap a key under another context.
    expect(by['email-senders']).toMatchObject({ orgSecrets });
    expect(by['webhooks']).toMatchObject({ orgSecrets });
    expect(by['email-senders']).not.toHaveProperty('keys');
    expect(by['webhooks']).not.toHaveProperty('keys');
  });

  it('every auth:user route has an isolation case, and every case names a route that exists', async () => {
    const routes: CollectedRoute[] = [];
    const { app: a } = await app(config(), { onRoute: (route) => collect(routes, route) });
    await a.ready();
    // Every module is filled in now: the approvals setup routes (WP-2.33), the email senders, notifications and email log
    // (WP-1.16), the exports (WP-1.17) and the webhooks (WP-1.18), so no stub is left to prove silent.
    const { missing, stale, duplicate } = coverage(routes, ISOLATION_CASES);
    expect({ missing, stale, duplicate }).toEqual({ missing: [], stale: [], duplicate: [] });
  });
});

describe('composition deps of the notification, webhook and export modules (WP-1.16, WP-1.17, WP-1.18)', () => {
  const fakeEgress: EgressGuard = { assertAllowed: async () => ({ pinnedIp: '203.0.113.9' }) };
  const fakeMailer: Mailer = { send: async () => ({ messageId: '<m@form.test>', refused: [] }), verify: async () => ({ ok: true }) };
  const fakeStorage = {} as Storage;
  const by = () => Object.fromEntries(registered.calls.map((c) => [c.module, c.deps]));

  it('starts with a fake tenant egress guard, org mailer and storage, and hands each to the module that uses it', async () => {
    const cfg = config();
    const orgMailer = () => fakeMailer;
    registered.calls.length = 0;
    const { app: a } = await app(cfg, { tenantEgress: fakeEgress, orgMailer, storage: fakeStorage });
    await a.ready();
    expect((await a.inject({ url: '/livez' })).statusCode).toBe(200);
    const deps = by();
    // The same objects, not copies: the guard is the one the composition root built, so the webhook URL check is the real one.
    expect(deps['webhooks']?.['tenantEgress']).toBe(fakeEgress);
    // The URL scheme rule reads EGRESS_POLICY, so the webhook routes get the edition of the config.
    expect(deps['webhooks']?.['edition']).toBe(cfg.edition);
    expect(deps['email-senders']?.['orgMailer']).toBe(orgMailer);
    expect(deps['exports']?.['storage']).toBe(fakeStorage);
    // No module gets what it does not use.
    expect(deps['notifications']).not.toHaveProperty('tenantEgress');
    expect(deps['notifications']).not.toHaveProperty('storage');
    expect(deps['webhooks']).not.toHaveProperty('storage');
    expect(deps['exports']).not.toHaveProperty('tenantEgress');
    expect(deps['exports']).not.toHaveProperty('orgMailer');
    expect(deps['reviews']).not.toHaveProperty('storage');
  });

  it('still starts without them: the modules get undefined, and answer 503 when they need one', async () => {
    registered.calls.length = 0;
    const { app: a } = await app();
    await a.ready();
    expect((await a.inject({ url: '/livez' })).statusCode).toBe(200);
    const deps = by();
    expect(deps['webhooks']?.['tenantEgress']).toBeUndefined();
    expect(deps['email-senders']?.['orgMailer']).toBeUndefined();
    expect(deps['exports']?.['storage']).toBeUndefined();
    // The app never builds a port itself: only the composition root does, so the secrets are absent here too.
    expect(deps['webhooks']?.['orgSecrets']).toBeUndefined();
  });
});

describe('the org mailer opens only the secrets of its own org (WP-1.16)', () => {
  const ORG_A = '0192f3a0-0000-7000-8000-00000000000a';
  const ORG_B = '0192f3a0-0000-7000-8000-00000000000b';
  const SECRET_A = '0192f3a0-0000-7000-8000-0000000000a1';
  const SECRET_B = '0192f3a0-0000-7000-8000-0000000000b1';
  const URL_A = 'smtp://org-a-user:org-a-pass@smtp.a.example:587';
  const URL_B = 'smtp://org-b-user:org-b-pass@smtp.b.example:587';
  const dialect = new PgDialect();

  /** What a stored `enc` looks like to these fakes: the data key is wrapped under one org, and the SMTP URL is the plaintext. */
  const sealed = (orgId: string, url: string) => ({ dek: Buffer.from(orgId).toString('base64url'), kekRef: 'fake-kms', pt: Buffer.from(url).toString('base64url') });
  const rows = [
    { id: SECRET_A, orgId: ORG_A, enc: sealed(ORG_A, URL_A) },
    { id: SECRET_B, orgId: ORG_B, enc: sealed(ORG_B, URL_B) },
  ];

  /**
   * A database that answers `secret_enc()` as the real one does (migration 0023): only a secret of the context's own org,
   * and only for the system actor, null for any other. Every statement is recorded with the org and the actor that
   * `withTenant` set before it.
   */
  function fakeDb() {
    const seen: Array<{ statement: 'set_config' | 'secret_enc'; org: string; actor: string; secretId?: string }> = [];
    let begun = 0;
    const db = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        begun += 1;
        let org = '';
        let actor = '';
        return fn({
          execute: async (q: SQL) => {
            const { sql: text, params } = dialect.sqlToQuery(q);
            if (text.includes('set_config')) {
              org = String(params[0]);
              actor = String(params[4]);
              seen.push({ statement: 'set_config', org, actor });
              return { rows: [] };
            }
            if (text.includes('secret_enc')) {
              const id = String(params[0]);
              seen.push({ statement: 'secret_enc', org, actor, secretId: id });
              const row = rows.find((r) => r.id === id);
              return { rows: [{ enc: row && row.orgId === org && actor === 'system' ? row.enc : null }] };
            }
            throw new Error(`unexpected statement: ${text}`);
          },
        });
      },
    } as unknown as Db;
    return { db, seen, begun: () => begun };
  }

  /** A KMS that records every context it was asked to unwrap under, and refuses a data key wrapped under another org. */
  function fakeKms() {
    const unwraps: KeyContext[] = [];
    const keys = {
      unwrap: async (wrapped: Uint8Array, _kekRef: string, ctx: KeyContext) => {
        unwraps.push({ ...ctx });
        if (Buffer.from(wrapped).toString() !== ctx.orgId) throw new PortError('integrity', 'the data key was wrapped for another org');
        return new Uint8Array(32);
      },
    } as unknown as KeyProvider;
    const orgSecrets: OrgSecrets = {
      seal: async () => Promise.reject(new Error('not used')),
      open: async (ctx, stored) => {
        const s = stored as ReturnType<typeof sealed>;
        await keys.unwrap(Buffer.from(s.dek, 'base64url'), s.kekRef, { orgId: ctx.orgId });
        return new Uint8Array(Buffer.from(s.pt, 'base64url'));
      },
    };
    return { orgSecrets, unwraps };
  }

  function setup() {
    const d = fakeDb();
    const kms = fakeKms();
    const built: OrgSmtpSenders[] = [];
    const tenantEgress: EgressGuard = { assertAllowed: async () => ({ pinnedIp: '203.0.113.9' }) };
    const orgMailer = createOrgMailer({
      db: d.db,
      orgSecrets: kms.orgSecrets,
      tenantEgress,
      makeSmtpMailer: (senders) => {
        built.push(senders);
        return { send: async () => ({ messageId: '<m@form.test>', refused: [] }), verify: async () => ({ ok: true }) };
      },
    });
    return { ...d, ...kms, orgMailer, built, tenantEgress };
  }

  it('is the orgMailer the app hands to the email sender routes, and opens its own secret as a system context of its own org', async () => {
    const t = setup();
    registered.calls.length = 0;
    const { app: a } = await app(config(), { orgMailer: t.orgMailer, tenantEgress: t.tenantEgress });
    await a.ready();
    expect(registered.calls.find((c) => c.module === 'email-senders')?.deps['orgMailer']).toBe(t.orgMailer);
    t.orgMailer(ORG_A);
    expect(await t.built[0]!.resolve(SECRET_A)).toBe(URL_A);
    // One read, in a context of org A that is the worker's kind of context (`secret_enc()` answers no one else), then one unwrap.
    expect(t.seen).toEqual([
      { statement: 'set_config', org: ORG_A, actor: 'system' },
      { statement: 'secret_enc', org: ORG_A, actor: 'system', secretId: SECRET_A },
    ]);
    expect(t.unwraps).toEqual([{ orgId: ORG_A }]);
  });

  it("never opens org B's secret for org A, whatever ref it is given, and asks the KMS under no org but A", async () => {
    const t = setup();
    t.orgMailer(ORG_A);
    // The ref is another org's secret id: the database answers null for it, so nothing is unwrapped and the mailer says not_found.
    expect(await t.built[0]!.resolve(SECRET_B)).toBeUndefined();
    expect(t.unwraps).toEqual([]);
    expect(await t.built[0]!.resolve(SECRET_A)).toBe(URL_A);
    expect(t.unwraps).toEqual([{ orgId: ORG_A }]);
    // Every statement ran for org A; org B never appears in a tenant context or in a KMS context.
    expect(new Set(t.seen.map((s) => s.org))).toEqual(new Set([ORG_A]));
    expect(t.unwraps.some((u) => u.orgId === ORG_B)).toBe(false);
    // And the other way round: org B's mailer opens B's secret under B, never A's.
    t.orgMailer(ORG_B);
    expect(await t.built[1]!.resolve(SECRET_A)).toBeUndefined();
    expect(await t.built[1]!.resolve(SECRET_B)).toBe(URL_B);
    expect(t.unwraps).toEqual([{ orgId: ORG_A }, { orgId: ORG_B }]);
  });

  it("refuses a sealed value of org B even if one reached org A's context: the KMS will not unwrap it under A", async () => {
    // A database that is wrong (or a row copied across orgs): the context is A but the row is B's. The key still does not open.
    const t = setup();
    const row = rows.find((r) => r.id === SECRET_B)!;
    const original = row.orgId;
    row.orgId = ORG_A;
    try {
      t.orgMailer(ORG_A);
      await expect(t.built[0]!.resolve(SECRET_B)).rejects.toMatchObject({ code: 'integrity' });
      expect(t.unwraps).toEqual([{ orgId: ORG_A }]);
    } finally {
      row.orgId = original;
    }
  });

  it('treats a ref that is not a uuid as no sender, without touching the database or the KMS, and refuses an org that is not a uuid', async () => {
    const t = setup();
    t.orgMailer(ORG_A);
    for (const ref of ['', 'not-a-uuid', `${SECRET_A}; drop table secrets`, 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) expect(await t.built[0]!.resolve(ref)).toBeUndefined();
    expect(t.begun()).toBe(0);
    expect(t.unwraps).toEqual([]);
    expect(() => t.orgMailer("x'; drop table orgs; --")).toThrow(TypeError);
    expect(t.built).toHaveLength(1);
  });

  it("holds an org's own relay to the tenant egress guard, never to the infrastructure one", () => {
    const t = setup();
    t.orgMailer(ORG_A);
    expect(t.built[0]!.egress).toBe(t.tenantEgress);
  });

  it('puts no SMTP URL or credential into a failure', async () => {
    const t = setup();
    t.orgMailer(ORG_A);
    const row = rows.find((r) => r.id === SECRET_A)!;
    const original = row.enc;
    // Org A's URL sealed under org B's key: A's context cannot open it.
    row.enc = sealed(ORG_B, URL_A);
    try {
      const failure = await t.built[0]!.resolve(SECRET_A).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(PortError);
      expect(JSON.stringify([(failure as Error).message, (failure as Error).stack])).not.toMatch(/org-a-pass|org-a-user|smtp\.a\.example/);
    } finally {
      row.enc = original;
    }
  });
});

describe('OpenAPI', () => {
  it('counts the routes that answer without a session, so a new public route is a decision', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(path.join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path.join(dir, e.name)] : [],
      );
    const open: Record<string, number> = {};
    for (const file of files(root)) {
      const n = readFileSync(file, 'utf8').split("auth: 'none'").length - 1;
      if (n > 0) open[path.relative(root, file).split(path.sep).join('/')] = n;
    }
    // Why each is public on purpose. app.ts: the API description. routes/health.ts: livez and readyz, no data.
    // routes/meta.ts: the edition summary, no data. routes/csp-reports.ts: browsers send reports without credentials.
    // modules/auth/routes.ts (11): methods, sign-up, link, verify-email, login, magic-link, magic-link/verify,
    // password/forgot, password/reset, mfa/totp, mfa/recovery: they create the session or answer before there is one.
    // modules/auth/oidc.ts (2): the OAuth start and callback. modules/account/routes.ts: the privacy notice shown
    // before sign-up. modules/orgs/members.ts: the invite lookup by its secret token. routes/public.ts (3): a published
    // form by slug, its file uploads, its answers: a respondent has no account (the anonymous writes are bound to the
    // live version of one form and validated there). routes/public-unlock.ts (1): the respondent's password check for a
    // protected form: the password is the credential, the route is limited per address and form, and every refusal is audited.
    expect(open).toEqual({
      'app.ts': 1,
      'modules/account/routes.ts': 1,
      'modules/auth/oidc.ts': 2,
      'modules/auth/routes.ts': 11,
      'modules/orgs/members.ts': 1,
      'routes/csp-reports.ts': 1,
      'routes/health.ts': 2,
      'routes/meta.ts': 1,
      'routes/public-unlock.ts': 1,
      'routes/public.ts': 3,
    });
  });

  it('documents the routes and the security schemes', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/livez',
      '/readyz',
      '/v1/auth/link',
      '/v1/auth/login',
      '/v1/auth/logout',
      '/v1/auth/magic-link',
      '/v1/auth/magic-link/verify',
      '/v1/auth/methods',
      '/v1/auth/mfa/recovery',
      '/v1/auth/mfa/recovery-codes',
      '/v1/auth/mfa/totp',
      '/v1/auth/mfa/totp/disable',
      '/v1/auth/mfa/totp/setup',
      '/v1/auth/mfa/totp/verify',
      '/v1/auth/password/forgot',
      '/v1/auth/password/reset',
      '/v1/auth/signup',
      '/v1/auth/verify-email',
      '/v1/csp-reports',
      '/v1/email-senders',
      '/v1/email-senders/{id}',
      '/v1/email-senders/{id}/test',
      '/v1/exports/{id}',
      '/v1/exports/{id}/download',
      '/v1/forms',
      '/v1/forms/merge',
      '/v1/forms/{formId}/email-log',
      '/v1/forms/{formId}/exports',
      '/v1/forms/{formId}/files/{id}',
      '/v1/forms/{formId}/notifications',
      '/v1/forms/{formId}/notifications/{id}',
      '/v1/forms/{formId}/submissions',
      '/v1/forms/{formId}/submissions/bulk',
      '/v1/forms/{formId}/submissions/{id}',
      '/v1/forms/{formId}/webhooks',
      '/v1/forms/{formId}/webhooks/{id}',
      '/v1/forms/{formId}/webhooks/{id}/deliveries',
      '/v1/forms/{formId}/webhooks/{id}/deliveries/{deliveryId}/replay',
      '/v1/forms/{formId}/webhooks/{id}/rotate-secret',
      '/v1/forms/{id}',
      '/v1/forms/{id}/access',
      '/v1/forms/{id}/access/password',
      '/v1/forms/{id}/archive',
      '/v1/forms/{id}/clone',
      '/v1/forms/{id}/draft',
      '/v1/forms/{id}/favourite',
      '/v1/forms/{id}/live',
      '/v1/forms/{id}/publish',
      '/v1/forms/{id}/restore',
      '/v1/forms/{id}/review',
      '/v1/forms/{id}/slug',
      '/v1/forms/{id}/trash',
      '/v1/forms/{id}/validate',
      '/v1/invites/accept',
      '/v1/invites/lookup',
      '/v1/me',
      '/v1/me/active-org',
      '/v1/me/delete',
      '/v1/me/deletion',
      '/v1/me/export',
      '/v1/me/grievances',
      '/v1/me/notice',
      '/v1/me/sessions',
      '/v1/me/sessions/{id}',
      '/v1/meta/edition',
      '/v1/org',
      '/v1/org/invites',
      '/v1/org/invites/{id}',
      '/v1/org/members',
      '/v1/org/members/{userId}',
      '/v1/org/members/{userId}/access-link',
      '/v1/org/review-groups',
      '/v1/org/review-groups/{id}',
      '/v1/org/review-groups/{id}/members/{userId}',
      '/v1/org/settings',
      '/v1/orgs',
      '/v1/p/{slug}',
      '/v1/p/{slug}/files',
      '/v1/p/{slug}/submissions',
      '/v1/p/{slug}/unlock',
      '/v1/privacy/notice',
      '/v1/reviews/queue',
    ]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['devUser', 'org', 'session']);
    expect(JSON.stringify(doc.paths['/v1/forms'])).toContain('"maximum":200');
  });
});
