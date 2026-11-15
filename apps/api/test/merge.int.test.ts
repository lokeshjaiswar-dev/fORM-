import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_merge');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'merge']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@merge.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);

  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

const as = (user: string) => ({ 'x-fr-dev-user': user, 'x-fr-org': orgId, ...BROWSER });

const para = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
});

function draftWithName(formId: string, title: string, label: string, config: Record<string, unknown> = {}) {
  const base = publishableDraft(formId, title);
  const block = {
    id: 'name_1',
    type: 'short_text',
    key: 'your_name',
    label: para(label),
    required: false,
    compliance: {
      classification: 'personal',
      purposeIds: ['pur_1'],
      encrypt: false,
      allowPrefill: false,
      inNotifications: 'include',
      inExports: 'include',
    },
    config,
  };
  return {
    ...base,
    blocks: { name_1: block },
    pages: [{ id: 'page_1', children: ['name_1'] }],
  };
}

async function createForm(title: string, draft: unknown): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title } });
  expect(created.statusCode).toBe(200);
  const { id } = created.json<{ id: string }>();
  const put = await app.inject({
    method: 'PUT',
    url: `/v1/forms/${id}/draft`,
    headers: { ...as(userId), 'if-match': '0' },
    payload: { draft: { ...(draft as object), formId: id } },
  });
  expect(put.statusCode).toBe(200);
  return id;
}

describe('POST /v1/forms/merge', () => {
  it('creates a grouped form when labels and types match', async () => {
    const a = await createForm('Alpha', draftWithName('tmp', 'Alpha', 'Your name', { maxLength: 200 }));
    const b = await createForm('Beta', draftWithName('tmp', 'Beta', 'Your name', { minLength: 2 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/forms/merge',
      headers: as(userId),
      payload: { formIds: [a, b] },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json<{ id: string }>();
    const got = await app.inject({ url: `/v1/forms/${id}/draft`, headers: as(userId) });
    expect(got.statusCode).toBe(200);
    const body = got.json<{ draft: { title: string; blocks: Record<string, { config?: { minLength?: number; maxLength?: number } }> } }>();
    expect(body.draft.title).toContain('Alpha');
    const name = Object.values(body.draft.blocks).find((block) => block.config);
    expect(name?.config).toMatchObject({ minLength: 2, maxLength: 200 });
  });

  it('returns conflicts when patterns differ, then succeeds after a choice', async () => {
    const a = await createForm('One', draftWithName('tmp', 'One', 'Code', { pattern: { source: '^[A-Z]+$' } }));
    const b = await createForm('Two', draftWithName('tmp', 'Two', 'Code', { pattern: { source: '^[0-9]+$' } }));
    const clash = await app.inject({
      method: 'POST',
      url: '/v1/forms/merge',
      headers: as(userId),
      payload: { formIds: [a, b] },
    });
    expect(clash.statusCode).toBe(409);
    const body = clash.json<{ status: string; conflicts: Array<{ reason: string; label: string }> }>();
    expect(body.status).toBe('conflict');
    expect(body.conflicts[0]?.reason).toBe('config.pattern');

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/forms/merge',
      headers: as(userId),
      payload: {
        formIds: [a, b],
        resolutions: [{ label: 'Code', type: 'short_text', chosenFormId: b }],
      },
    });
    expect(ok.statusCode).toBe(200);
  });
});
