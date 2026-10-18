import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db, DbHandle } from '@form/db';
import type { ClockStatus } from '@form/observability';
import { buildApp, BODY_LIMIT, type AppDeps } from './app.ts';
import { parseConfig, type ApiConfig } from './config.ts';

function config(env: Record<string, string> = {}): ApiConfig {
  const r = parseConfig({
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: 'postgres://fr_app:x@127.0.0.1:1/form',
    LOG_LEVEL: 'info',
    PUBLIC_BUILDER_URL: 'https://app.form.test',
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
    expect(replaced.headers['x-request-id']).not.toContain('bad');
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

  it('maps body limits to PAYLOAD_TOO_LARGE', async () => {
    const { app: a } = await app();
    a.post('/echo', { config: { auth: 'none' } }, async (req) => req.body);
    const res = await a.inject({ method: 'POST', url: '/echo', payload: { big: 'x'.repeat(BODY_LIMIT) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
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

describe('OpenAPI', () => {
  it('documents the routes and the dev security schemes', async () => {
    const { app: a } = await app();
    const res = await a.inject({ url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual(['/livez', '/readyz', '/v1/forms']);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['devUser', 'org']);
    expect(JSON.stringify(doc.paths['/v1/forms'])).toContain('"maximum":200');
  });
});
