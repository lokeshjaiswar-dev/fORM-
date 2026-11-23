import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { BlockId, FieldBlockOf, FieldKey, FormDefinition, InlineDoc, Locale, UniqueIdConfig } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';
import { publishableDraft } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;
const REF = 'unique_id_1' as BlockId;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_unique_ids');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'serials']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@serials.test']);
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
const inline = (text: string): InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** A form with one `unique_id` field (the builder's Auto increment default unless `config` says otherwise). */
function draftWithSerial(formId: string, config: Partial<UniqueIdConfig> = {}): FormDefinition {
  const base = publishableDraft(formId, 'Serial form');
  const field = {
    id: REF,
    type: 'unique_id',
    key: 'reference' as FieldKey,
    label: inline('Reference'),
    required: false,
    compliance: { ...DEFAULT_COMPLIANCE.unique_id, purposeIds: [] },
    config: { ...REGISTRY.unique_id.defaultConfig('en-IN' as Locale), prefix: [], padTo: 1, startAt: 1, resetEvery: 'never', showOnEnding: false, ...config },
  } as FieldBlockOf<'unique_id'>;
  return {
    ...base,
    blocks: { [REF]: field },
    pages: [{ ...base.pages[0]!, children: [REF] }],
  };
}

async function createForm(config: Partial<UniqueIdConfig> = {}): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'Serial form' } });
  expect(created.statusCode).toBe(200);
  const { id } = created.json<{ id: string }>();
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: as(userId), payload: { draft: draftWithSerial(id, config) } });
  expect(put.statusCode).toBe(200);
  return id;
}

async function publish(formId: string): Promise<{ slug: string; versionId: string }> {
  const published = await app.inject({ method: 'POST', url: `/v1/forms/${formId}/publish`, headers: as(userId) });
  expect(published.statusCode).toBe(200);
  return published.json<{ slug: string; versionId: string }>();
}

/** What a respondent's browser sends: the preview value the evaluator computed from prefix + startAt. */
function publicSubmit(live: { slug: string; versionId: string }, preview = '1') {
  return app.inject({
    method: 'POST',
    url: `/v1/p/${live.slug}/submissions`,
    payload: {
      formVersionId: live.versionId,
      answers: { [REF]: { type: 'unique_id', value: preview } },
      fields: [{ key: 'reference', label: 'Reference', value: preview }],
      locale: 'en-IN',
    },
  });
}

async function storedReference(id: string): Promise<{ answer: unknown; field: string | undefined }> {
  const { rows } = await owner.query<{ answers: Record<string, unknown>; fields: Array<{ key: string; value: string }> }>(
    'select answers, fields from form_submissions where id = $1',
    [id],
  );
  const row = rows[0];
  return { answer: row?.answers[REF], field: row?.fields.find((f) => f.key === 'reference')?.value };
}

describe('unique_id on a published form', () => {
  it('gives two submissions 1 and 2 and stores the issued value, not the preview', async () => {
    const live = await publish(await createForm());
    const first = await publicSubmit(live);
    const second = await publicSubmit(live);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json<{ id: string; uniqueIds: Record<string, string> }>();
    const b = second.json<{ id: string; uniqueIds: Record<string, string> }>();
    expect(a.uniqueIds).toEqual({ [REF]: '1' });
    expect(b.uniqueIds).toEqual({ [REF]: '2' });
    // showOnEnding is off, so nothing is offered for the ending.
    expect(a).not.toHaveProperty('uniqueId');
    expect(await storedReference(b.id)).toEqual({ answer: { type: 'unique_id', value: '2' }, field: '2' });
  });

  it('pads and prefixes, and returns the value for the ending when showOnEnding is on', async () => {
    const live = await publish(await createForm({ prefix: ['APP-'], padTo: 6, startAt: 1, showOnEnding: true }));
    const first = await publicSubmit(live, 'APP-000001');
    const second = await publicSubmit(live, 'APP-000001');
    expect(first.json()).toMatchObject({ uniqueId: 'APP-000001' });
    expect(second.json()).toMatchObject({ uniqueId: 'APP-000002' });
  });

  it('never gives two concurrent submissions the same number', async () => {
    const live = await publish(await createForm());
    const responses = await Promise.all(Array.from({ length: 12 }, () => publicSubmit(live)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(12).fill(200));
    const values = responses.map((r) => r.json<{ uniqueIds: Record<string, string> }>().uniqueIds[REF]!);
    expect(new Set(values).size).toBe(12);
    expect(values.map(Number).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('counts each form on its own', async () => {
    const one = await publish(await createForm());
    const two = await publish(await createForm());
    expect((await publicSubmit(one)).json()).toMatchObject({ uniqueIds: { [REF]: '1' } });
    expect((await publicSubmit(two)).json()).toMatchObject({ uniqueIds: { [REF]: '1' } });
    expect((await publicSubmit(one)).json()).toMatchObject({ uniqueIds: { [REF]: '2' } });
  });

  it('keys a monthly field by the month in the form time zone', async () => {
    const formId = await createForm({ resetEvery: 'month' });
    const live = await publish(formId);
    const monthNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const before = monthNow();
    expect((await publicSubmit(live)).json()).toMatchObject({ uniqueIds: { [REF]: '1' } });
    const after = monthNow();
    const { rows } = await owner.query<{ period: string; last_value: string }>(
      'select period, last_value::text from form_serial_counters where form_id = $1',
      [formId],
    );
    expect(rows).toHaveLength(1);
    expect([before, after]).toContain(rows[0]!.period);
    expect(rows[0]!.last_value).toBe('1');
    // A counter left over from last month does not affect this month's numbers.
    await owner.query(`insert into form_serial_counters (org_id, form_id, block_id, period, last_value) values ($1, $2, $3, '2000-01', 99)`, [orgId, formId, REF]);
    expect((await publicSubmit(live)).json()).toMatchObject({ uniqueIds: { [REF]: '2' } });
  });
});

describe('unique_id on a signed-in submission', () => {
  it('numbers submissions from the draft of an unpublished form', async () => {
    const formId = await createForm({ prefix: ['T-'], padTo: 3, startAt: 7, showOnEnding: true });
    const submit = () =>
      app.inject({
        method: 'POST',
        url: `/v1/forms/${formId}/submissions`,
        headers: as(userId),
        payload: { answers: { [REF]: { type: 'unique_id', value: 'T-007' } }, fields: [{ key: 'reference', label: 'Reference', value: 'T-007' }] },
      });
    const first = await submit();
    const second = await submit();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ uniqueId: 'T-007' });
    expect(second.json()).toMatchObject({ uniqueId: 'T-008' });
    expect(await storedReference(second.json<{ id: string }>().id)).toEqual({ answer: { type: 'unique_id', value: 'T-008' }, field: 'T-008' });
  });

  it('leaves forms without a unique_id field as they were', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'Plain' } });
    const { id } = created.json<{ id: string }>();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/forms/${id}/submissions`,
      headers: as(userId),
      payload: { answers: {}, fields: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: expect.any(String) });
  });
});
