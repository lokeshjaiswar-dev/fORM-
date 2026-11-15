import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { RuntimeFormVersionSchema, type FormDefinition } from '@form/schema';
import { TEST_PASSWORDS } from './global-setup.ts';
import { draftWith, fieldBlock, publishableDraft, withLogicCycle, withRedirectEnding } from './publishable-draft.ts';

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let userId: string;
let viewerId: string;
let otherOrgId: string;
let otherUserId: string;

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_publish');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  userId = randomUUID();
  viewerId = randomUUID();
  otherOrgId = randomUUID();
  otherUserId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [orgId, 'live']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [userId, 'owner@live.test']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [viewerId, 'viewer@live.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, viewerId, 'viewer']);
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [otherOrgId, 'elsewhere']);
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [otherUserId, 'owner@elsewhere.test']);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [otherOrgId, otherUserId, 'owner']);

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

const as = (user: string, org = orgId) => ({ 'x-fr-dev-user': user, 'x-fr-org': org, ...BROWSER });

/**
 * A form row with a saved draft, as the builder leaves it before Publish. A draft the save route refuses (an unknown
 * key, another form's id) is `planted` with SQL instead: the strict save only came with WP-1.06, so such rows exist from
 * before it and from the prototype, and publish has to turn them away too.
 */
async function savedForm(draft: (id: string) => FormDefinition = (id) => publishableDraft(id), o: { planted?: boolean } = {}): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'Live form' } });
  expect(created.statusCode).toBe(200);
  const { id } = created.json<{ id: string }>();
  if (o.planted) {
    const definition = JSON.stringify(draft(id));
    await owner.query(
      `insert into form_drafts (form_id, org_id, draft, draft_rev, schema_version, size_bytes, updated_by) values ($1, $2, $3, 1, 2, $4, $5)`,
      [id, orgId, definition, Buffer.byteLength(definition, 'utf8'), userId],
    );
    return id;
  }
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(userId), 'if-match': '0' }, payload: { draft: draft(id) } });
  expect(put.statusCode, put.body).toBe(200);
  return id;
}

const withCover = (assetId: string) => (id: string): FormDefinition => {
  const base = publishableDraft(id);
  return { ...base, theme: { ...base.theme, tokens: { ...base.theme.tokens, cover: { image: { assetId }, heightPx: 200 } } } } as unknown as FormDefinition;
};

describe('publish and public fill', () => {
  it('publishes the saved draft and accepts an anonymous submission on the slug', async () => {
    const id = await savedForm();

    const published = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId) });
    expect(published.statusCode).toBe(200);
    const live = published.json<{ slug: string; versionId: string; number: number }>();
    expect(live.number).toBe(1);
    expect(live.slug).toContain(id.slice(-8));

    const again = await app.inject({ url: `/v1/forms/${id}/live`, headers: as(userId) });
    expect(again.json()).toMatchObject({ slug: live.slug, versionId: live.versionId });

    const publicGet = await app.inject({ url: `/v1/p/${live.slug}` });
    expect(publicGet.statusCode).toBe(200);
    const body = publicGet.json<{ formId: string; version: { versionId: string; status: { state: string } } }>();
    expect(body.formId).toBe(id);
    expect(body.version.versionId).toBe(live.versionId);
    expect(body.version.status.state).toBe('open');
    expect(RuntimeFormVersionSchema.safeParse(body.version).success).toBe(true);

    const submit = await app.inject({
      method: 'POST',
      url: `/v1/p/${live.slug}/submissions`,
      payload: { formVersionId: live.versionId, answers: {}, fields: [], locale: 'en-IN' },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json()).toEqual({ id: expect.any(String) });
  });

  it('keeps the slug and numbers the next version when a form is published again, without naming a draft revision', async () => {
    const id = await savedForm();
    const first = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} })).json<{ slug: string; versionId: string }>();
    const second = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} })).json<{ slug: string; versionId: string; number: number }>();
    expect(second.slug).toBe(first.slug);
    expect(second.number).toBe(2);
    const publicGet = await app.inject({ url: `/v1/p/${first.slug}` });
    expect(publicGet.json<{ version: { versionId: string } }>().version.versionId).toBe(second.versionId);
  });

  it('refuses an unpublished slug', async () => {
    const res = await app.inject({ url: '/v1/p/missing-form' });
    expect(res.statusCode).toBe(404);
  });

  it('records who published each version on the org’s audit log (form.published), without an address', async () => {
    const id = await savedForm();
    const live = (await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: { ...as(userId), 'user-agent': 'audit-test' }, payload: {} })).json<{ slug: string; versionId: string; number: number }>();
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'action' = 'form.published' and event->>'resourceId' = $2`, [orgId, live.versionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      actorKind: 'user',
      actorId: userId,
      action: 'form.published',
      resourceType: 'form_version',
      resourceId: live.versionId,
      formId: id,
      outcome: 'success',
      metadata: { number: live.number, slug: live.slug },
    });
    expect(JSON.stringify(rows[0]!.event)).not.toMatch(/127\.0\.0\.1/);
    // A publish that fails (no draft) records nothing.
    const created = await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'No draft' } });
    const bare = created.json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/v1/forms/${bare}/publish`, headers: as(userId), payload: {} });
    const none = await owner.query(`select 1 from audit_pending where event->>'action' = 'form.published' and event->>'formId' = $1`, [bare]);
    expect(none.rows).toEqual([]);
  });
});

describe('publishing needs a signed-in member with forms.publish', () => {
  it('has no anonymous publish route, and an anonymous post creates nothing', async () => {
    const id = randomUUID();
    const before = (await owner.query<{ n: number }>('select count(*)::int as n from forms')).rows[0]!.n;
    for (const headers of [{}, BROWSER]) {
      const res = await app.inject({ method: 'POST', url: '/v1/p/publish', headers, payload: { id, draft: publishableDraft(id, 'Phone form') } });
      expect(res.statusCode).toBe(404);
    }
    expect((await owner.query<{ n: number }>('select count(*)::int as n from forms')).rows[0]!.n).toBe(before);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('answers 401 without a session', async () => {
    const id = await savedForm();
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: BROWSER })).statusCode).toBe(401);
  });

  it('refuses a member whose role cannot publish', async () => {
    const id = await savedForm();
    const res = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(viewerId), payload: {} });
    expect(res.statusCode).toBe(403);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('does not publish into, or out of, another org', async () => {
    const id = await savedForm();
    // A member of another org naming their own org: the form is not theirs.
    const own = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(otherUserId, otherOrgId), payload: {} });
    expect(own.statusCode).toBe(404);
    // ... naming the form's org: not a member.
    const named = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(otherUserId, orgId), payload: {} });
    expect(named.statusCode).toBe(403);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('files every published form under the caller’s org, never another one', async () => {
    const id = await savedForm();
    await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: {} });
    const { rows } = await owner.query<{ org_id: string; published_by: string }>('select org_id, published_by from form_versions where form_id = $1', [id]);
    expect(rows).toEqual([{ org_id: orgId, published_by: userId }]);
  });
});

describe('the pictures a form uses', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('are stored with the version, only the ones the definition names, and shown on the public page', async () => {
    const id = await savedForm(withCover('pic1'));
    const published = await app.inject({
      method: 'POST',
      url: `/v1/forms/${id}/publish`,
      headers: as(userId),
      payload: { media: { pic1: PNG, unused: PNG } },
    });
    expect(published.statusCode).toBe(200);
    const { slug } = published.json<{ slug: string }>();
    const publicGet = await app.inject({ url: `/v1/p/${slug}` });
    expect(publicGet.json()).toMatchObject({ media: { pic1: PNG } });
    expect(Object.keys(publicGet.json<{ media: Record<string, string> }>().media)).toEqual(['pic1']);
  });

  it('refuse anything that is not a raster data URL (an SVG can carry script)', async () => {
    const id = await savedForm(withCover('pic1'));
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'https://evil.example/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+']) {
      const res = await app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers: as(userId), payload: { media: { pic1: bad } } });
      expect(res.statusCode).toBe(400);
    }
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// WP-1.07: the publish pipeline, idempotency by draft revision, versions, and the dry run.
// ---------------------------------------------------------------------------------------------------------------

interface Issue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}
interface Live {
  slug: string;
  versionId: string;
  number: number;
  draftRev: number | null;
}

const publish = (id: string, payload?: Record<string, unknown>, headers: Record<string, string> = as(userId)) =>
  app.inject({ method: 'POST', url: `/v1/forms/${id}/publish`, headers, ...(payload === undefined ? {} : { payload }) });
const validate = (id: string, headers: Record<string, string> = as(userId)) => app.inject({ method: 'POST', url: `/v1/forms/${id}/validate`, headers, payload: {} });

/** Saves `draft` over the revision the form is at, as the builder does, and returns the revision the save made. */
async function saveDraft(id: string, draft: unknown): Promise<number> {
  const { rows } = await owner.query<{ draft_rev: number }>('select draft_rev from form_drafts where form_id = $1', [id]);
  const put = await app.inject({ method: 'PUT', url: `/v1/forms/${id}/draft`, headers: { ...as(userId), 'if-match': String(rows[0]?.draft_rev ?? 0) }, payload: { draft } });
  expect(put.statusCode, put.body).toBe(200);
  return put.json<{ draftRev: number }>().draftRev;
}

const versionRows = async (id: string) =>
  (
    await owner.query<{
      id: string;
      number: number;
      draft_rev: number | null;
      label: string | null;
      engine: string;
      content_hash: string;
      definition: FormDefinition;
      compiled: unknown;
      template_lineage: unknown;
      variables_snapshot: unknown;
      superseded_at: Date | null;
    }>(
      `select v.id, v.number, v.draft_rev, v.label, v.engine, v.content_hash, v.definition, v.compiled, v.template_lineage, v.variables_snapshot, s.superseded_at
         from form_versions v join form_version_state s on s.version_id = v.id
        where v.form_id = $1 order by v.number`,
      [id],
    )
  ).rows;

const formState = async (id: string) => (await owner.query<{ live_version_id: string | null; slug: string | null }>('select live_version_id, slug from forms where id = $1', [id])).rows[0]!;
const auditCount = async (action: string, formId: string) =>
  (await owner.query<{ n: number }>(`select count(*)::int as n from audit_pending where event->>'action' = $1 and event->>'formId' = $2`, [action, formId])).rows[0]!.n;

/** A draft with an unsafe regex, a javascript: redirect and a logic cycle: three reasons, one per check. */
const brokenDraft = (id: string): FormDefinition =>
  withLogicCycle(
    withRedirectEnding(draftWith(id, [fieldBlock('name', 'short_text'), fieldBlock('code', 'short_text', { pattern: { source: '(?=a)b' } })]), ['javascript:alert(1)']),
    'name',
  );

describe('the publish checks (422 PUBLISH_BLOCKED)', () => {
  const expected = [
    { code: 'unsafe_regex', path: '/blocks/code/config/pattern/source', severity: 'error' },
    { code: 'invalid_url_scheme', path: '/endings/1/url', severity: 'error' },
    { code: 'logic_cycle', path: '/logic/rules/0', severity: 'error' },
  ];

  it('refuses a draft with an unsafe regex, a javascript: redirect and a logic cycle, listing each with its path, and stores nothing', async () => {
    const id = await savedForm(brokenDraft);
    const res = await publish(id, { expectedDraftRev: 1 });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json<{ code: string; status: number; detail: string; issues: Issue[]; issueCount: number; requestId: string }>();
    expect(body).toMatchObject({ code: 'PUBLISH_BLOCKED', status: 422, issueCount: body.issues.length, requestId: expect.any(String) });
    expect(body.detail).toMatch(/^3 problems to fix/);
    for (const want of expected) expect(body.issues).toContainEqual(expect.objectContaining({ ...want, message: expect.any(String) }));
    // Nothing was stored and nothing went live.
    expect(await versionRows(id)).toEqual([]);
    expect(await formState(id)).toEqual({ live_version_id: null, slug: null });
    expect((await owner.query('select 1 from form_slugs where form_id = $1', [id])).rowCount).toBe(0);
    expect(await auditCount('form.published', id)).toBe(0);
  });

  it.each([
    ['an unsafe regex', (id: string) => draftWith(id, [fieldBlock('code', 'short_text', { pattern: { source: '(?<=a)b' } })]), expected[0]!],
    ['a javascript: redirect', (id: string) => withRedirectEnding(publishableDraft(id), ['javascript:alert(1)']), expected[1]!],
    ['a logic cycle', (id: string) => withLogicCycle(draftWith(id, [fieldBlock('name', 'short_text')]), 'name'), expected[2]!],
  ])('refuses %s on its own', async (_name, draft, want) => {
    const id = await savedForm(draft);
    const res = await publish(id, { expectedDraftRev: 1 });
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json<{ code: string; issues: Issue[] }>();
    expect(body.code).toBe('PUBLISH_BLOCKED');
    expect(body.issues.filter((i) => i.severity === 'error').map(({ code, path }) => ({ code, path }))).toEqual([{ code: want.code, path: want.path }]);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('refuses a saved draft that is not a v2 form (the parse is strict: an unknown key is refused, not dropped)', async () => {
    const id = await savedForm((fid) => ({ ...publishableDraft(fid), smuggled: { note: 'kept by nobody' } }) as unknown as FormDefinition, { planted: true });
    const res = await publish(id, {});
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json<{ code: string; issues: Issue[] }>();
    expect(body.code).toBe('PUBLISH_BLOCKED');
    expect(body.issues).toEqual([expect.objectContaining({ code: 'invalid_definition', severity: 'error', message: expect.stringContaining('smuggled') })]);
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });

  it('applies the form’s redirect allowlist (redirect_not_allowed), and only when the form set one', async () => {
    const redirectTo = (url: string) => (fid: string) => withRedirectEnding(publishableDraft(fid), [url]);
    const open = await savedForm(redirectTo('https://anywhere.example/thanks'));
    expect((await publish(open, {})).statusCode).toBe(200);

    const listed = await savedForm(redirectTo('https://evil.example/thanks'));
    await owner.query('insert into form_access (form_id, org_id, redirect_allowlist) values ($1, $2, $3)', [listed, orgId, ['forms.live.test']]);
    const refused = await publish(listed, {});
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ issues: Issue[] }>().issues).toContainEqual(expect.objectContaining({ code: 'redirect_not_allowed', path: '/endings/1/url', severity: 'error' }));
    expect((await owner.query('select 1 from form_versions where form_id = $1', [listed])).rowCount).toBe(0);

    await saveDraft(listed, redirectTo('https://forms.live.test/thanks')(listed));
    expect((await publish(listed, {})).statusCode).toBe(200);
  });

  it('caps the list at 200 issues and says how many there were', async () => {
    const many = (fid: string) => draftWith(fid, Array.from({ length: 220 }, (_v, i) => fieldBlock(`f${i}`, 'short_text', { pattern: { source: '(?=a)b' } })));
    const id = await savedForm(many);
    const res = await publish(id, {});
    expect(res.statusCode).toBe(422);
    const body = res.json<{ issues: Issue[]; issueCount: number }>();
    expect(body.issues).toHaveLength(200);
    expect(body.issueCount).toBeGreaterThanOrEqual(220);
  });
});

describe('the client’s compiled plan (422 PLAN_MISMATCH)', () => {
  it('refuses a hash that differs from the server’s compile, stores no version and no plan', async () => {
    const id = await savedForm();
    const forged = 'f'.repeat(64);
    const res = await publish(id, { expectedDraftRev: 1, clientDefinitionHash: forged });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ code: 'PLAN_MISMATCH', status: 422, detail: expect.stringContaining(forged) });
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
    expect(await formState(id)).toEqual({ live_version_id: null, slug: null });
    expect(await auditCount('form.published', id)).toBe(0);
  });

  it('publishes when the client’s hash is the server’s, and what is stored is the server’s plan', async () => {
    const id = await savedForm();
    const { definitionHash } = (await validate(id)).json<{ definitionHash: string }>();
    const res = await publish(id, { expectedDraftRev: 1, clientDefinitionHash: definitionHash });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await versionRows(id);
    expect(row!.content_hash).toBe(definitionHash);
    expect((row!.compiled as { definitionHash: string }).definitionHash).toBe(definitionHash);
  });

  it('answers a malformed hash or an unknown key in the body with 400, before anything is read', async () => {
    const id = await savedForm();
    for (const payload of [{ clientDefinitionHash: 'not-a-hash' }, { expectedDraftRev: 0 }, { expectedDraftRev: 1.5 }, { compiled: { plan: [] } }, { label: 'x'.repeat(121) }, { label: 'bell\u0007' }]) {
      const res = await publish(id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await owner.query('select 1 from form_versions where form_id = $1', [id])).rowCount).toBe(0);
  });
});

describe('idempotent by draft revision (409 DRAFT_REV_CONFLICT)', () => {
  it('returns the same version for the same expectedDraftRev, and writes one version, one audit record', async () => {
    const id = await savedForm();
    const first = await publish(id, { expectedDraftRev: 1 });
    const second = await publish(id, { expectedDraftRev: 1 });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const a = first.json<Live>();
    const b = second.json<Live>();
    expect(b).toEqual(a);
    expect(a).toMatchObject({ number: 1, draftRev: 1 });
    expect(await versionRows(id)).toHaveLength(1);
    expect(await auditCount('form.published', id)).toBe(1);
  });

  it('refuses a stale expectedDraftRev with 409 and publishes nothing', async () => {
    const id = await savedForm();
    expect(await saveDraft(id, publishableDraft(id, 'Edited'))).toBe(2);
    for (const stale of [1, 5]) {
      const res = await publish(id, { expectedDraftRev: stale });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'DRAFT_REV_CONFLICT', detail: expect.stringContaining('revision 2') });
    }
    expect(await versionRows(id)).toEqual([]);
    const fresh = await publish(id, { expectedDraftRev: 2 });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json()).toMatchObject({ number: 1, draftRev: 2 });
  });

  it('answers a retry with the version that revision became, even after the draft moved on, and numbers the next revision on', async () => {
    const id = await savedForm();
    const v1 = (await publish(id, { expectedDraftRev: 1 })).json<Live>();
    expect(await saveDraft(id, publishableDraft(id, 'Edited later'))).toBe(2);
    // The answer to the first publish was lost and the builder autosaved meanwhile: the retry is a replay, not a conflict.
    const retry = await publish(id, { expectedDraftRev: 1 });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<Live>()).toEqual(v1);
    const v2 = (await publish(id, { expectedDraftRev: 2 })).json<Live>();
    expect(v2).toMatchObject({ number: 2, draftRev: 2, slug: v1.slug });
    expect(v2.versionId).not.toBe(v1.versionId);
    expect((await versionRows(id)).map((r) => [r.number, r.draft_rev])).toEqual([[1, 1], [2, 2]]);
  });

  it('writes one version when the same revision is published many times at once', async () => {
    const id = await savedForm();
    const results = await Promise.all(Array.from({ length: 6 }, () => publish(id, { expectedDraftRev: 1 })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.json<Live>().versionId)).size).toBe(1);
    expect(await versionRows(id)).toHaveLength(1);
    expect(await auditCount('form.published', id)).toBe(1);
  });

  it('numbers versions one after the other when publishes that name no revision race', async () => {
    const id = await savedForm();
    const racing = await Promise.all([1, 2, 3].map(() => publish(id, {})));
    // Each is a new publish of the current draft: three versions, numbered 1..3, no gaps, no 500.
    expect(racing.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect((await versionRows(id)).map((r) => r.number)).toEqual([1, 2, 3]);
    expect(racing.map((r) => r.json<Live>().number).sort()).toEqual([1, 2, 3]);
  });
});

describe('versions and going live', () => {
  it('supersedes the previous version, makes the new one live, and stores the plan the server compiles from the stored definition', async () => {
    const id = await savedForm();
    const v1 = (await publish(id, { expectedDraftRev: 1, label: 'First' })).json<Live>();
    expect(await formState(id)).toEqual({ live_version_id: v1.versionId, slug: v1.slug });
    let rows = await versionRows(id);
    expect(rows[0]!.superseded_at).toBeNull();

    await saveDraft(id, draftWith(id, [fieldBlock('name', 'short_text', {}, { required: true })], 'Second form title'));
    const v2 = (await publish(id, { expectedDraftRev: 2, label: '  Second  ' })).json<Live>();
    expect(v2).toMatchObject({ number: 2, slug: v1.slug });

    rows = await versionRows(id);
    expect(rows.map((r) => r.id)).toEqual([v1.versionId, v2.versionId]);
    expect(rows[0]!.superseded_at).toBeInstanceOf(Date);
    expect(rows[1]!.superseded_at).toBeNull();
    expect(await formState(id)).toEqual({ live_version_id: v2.versionId, slug: v1.slug });
    expect(rows.map((r) => r.label)).toEqual(['First', 'Second']);

    for (const row of rows) {
      const again = compile(row.definition, REGISTRY);
      expect(again.ok).toBe(true);
      expect(row.compiled).toEqual(again.ok ? again.compiled : undefined);
      expect(row.content_hash).toBe((row.compiled as { definitionHash: string }).definitionHash);
      expect([row.engine, row.template_lineage, row.variables_snapshot]).toEqual(['logic@2', [], {}]);
    }
    // The stored definition is the draft that was saved, not the earlier one.
    expect(rows[1]!.definition.title).toBe('Second form title');
    // Superseding stopped at the previous version: a third publish leaves the first one's date alone.
    const firstSuperseded = rows[0]!.superseded_at;
    await publish(id, {});
    rows = await versionRows(id);
    expect(rows[0]!.superseded_at).toEqual(firstSuperseded);
    expect(rows[1]!.superseded_at).toBeInstanceOf(Date);
    expect(rows[2]!.superseded_at).toBeNull();
  });

  it('gives the form its one primary address on the first publish and keeps it on the next', async () => {
    const id = await savedForm();
    const v1 = (await publish(id, {})).json<Live>();
    await publish(id, {});
    const { rows } = await owner.query<{ slug: string; is_primary: boolean; org_id: string }>('select slug, is_primary, org_id from form_slugs where form_id = $1', [id]);
    expect(rows).toEqual([{ slug: v1.slug, is_primary: true, org_id: orgId }]);
    const live = await app.inject({ url: `/v1/forms/${id}/live`, headers: as(userId) });
    expect(live.json()).toMatchObject({ slug: v1.slug, number: 2, draftRev: 1 });
  });

  it('takes a longer address when another org’s form already holds the one it would get', async () => {
    const id = randomUUID();
    const squatter = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(otherUserId, otherOrgId), payload: { title: 'Squatter' } })).json<{ id: string }>().id;
    await owner.query('update forms set slug = $1 where id = $2', [`live-form-${id.slice(-8)}`, squatter]);
    expect((await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { id, title: 'Live form' } })).statusCode).toBe(200);
    await saveDraft(id, publishableDraft(id));
    const res = await publish(id, {});
    expect(res.statusCode, res.body).toBe(200);
    const live = res.json<Live>();
    expect(live.slug).toBe(`live-form-${id.replaceAll('-', '')}`);
    expect((await app.inject({ url: `/v1/p/${live.slug}` })).json()).toMatchObject({ formId: id });
    // The other org's address is untouched.
    expect((await owner.query<{ slug: string }>('select slug from forms where id = $1', [squatter])).rows[0]!.slug).toBe(`live-form-${id.slice(-8)}`);
  });

  it('freezes the form id the route names, whatever id the draft carries', async () => {
    const elsewhere = randomUUID();
    const id = await savedForm(() => publishableDraft(elsewhere), { planted: true });
    expect((await publish(id, {})).statusCode).toBe(200);
    expect((await versionRows(id))[0]!.definition.formId).toBe(id);
  });

  it('records the revision, hash and label in the audit record, and nothing for a replayed publish', async () => {
    const id = await savedForm();
    const live = (await publish(id, { expectedDraftRev: 1, label: 'Launch' })).json<Live>();
    await publish(id, { expectedDraftRev: 1 });
    const { rows } = await owner.query<{ event: { metadata: Record<string, unknown> } }>(
      `select event from audit_pending where event->>'action' = 'form.published' and event->>'resourceId' = $1`,
      [live.versionId],
    );
    expect(rows).toHaveLength(1);
    const [row] = await versionRows(id);
    expect(rows[0]!.event.metadata).toMatchObject({ number: 1, slug: live.slug, draftRev: 1, contentHash: row!.content_hash, label: 'Launch' });
  });

  it('does not publish a form that is in the trash', async () => {
    const id = await savedForm();
    await owner.query(`update forms set lifecycle = 'trashed', trashed_at = now() where id = $1`, [id]);
    const res = await publish(id, { expectedDraftRev: 1 });
    expect(res.statusCode).toBe(404);
    expect(await versionRows(id)).toEqual([]);
  });
});

describe('POST /v1/forms/:id/validate', () => {
  it('lists the issues a publish would stop at, with paths, and writes nothing', async () => {
    const id = await savedForm(brokenDraft);
    const versions = (await owner.query<{ n: number }>('select count(*)::int as n from form_versions')).rows[0]!.n;
    const audits = (await owner.query<{ n: number }>('select count(*)::int as n from audit_pending')).rows[0]!.n;
    const res = await validate(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ ok: boolean; draftRev: number; definitionHash: string | null; issues: Issue[]; issueCount: number }>();
    expect(body).toMatchObject({ ok: false, draftRev: 1, definitionHash: null, issueCount: body.issues.length });
    for (const code of ['unsafe_regex', 'invalid_url_scheme', 'logic_cycle']) {
      expect(body.issues).toContainEqual(expect.objectContaining({ code, severity: 'error', path: expect.stringMatching(/^\//) }));
    }
    expect((await owner.query<{ n: number }>('select count(*)::int as n from form_versions')).rows[0]!.n).toBe(versions);
    expect((await owner.query<{ n: number }>('select count(*)::int as n from audit_pending')).rows[0]!.n).toBe(audits);
    expect(await formState(id)).toEqual({ live_version_id: null, slug: null });
  });

  it('says ok for a draft that publishes, with the hash the publish will store', async () => {
    const id = await savedForm();
    const res = await validate(id);
    const body = res.json<{ ok: boolean; draftRev: number; definitionHash: string; issues: Issue[] }>();
    expect(body).toMatchObject({ ok: true, draftRev: 1, definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(body.issues.filter((i) => i.severity === 'error')).toEqual([]);
    await publish(id, { expectedDraftRev: 1 });
    expect((await versionRows(id))[0]!.content_hash).toBe(body.definitionHash);
  });

  it('reports a not-v2 draft as invalid_definition, and a form with no draft as 404', async () => {
    const id = await savedForm((fid) => ({ ...publishableDraft(fid), smuggled: 1 }) as unknown as FormDefinition, { planted: true });
    expect((await validate(id)).json()).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'invalid_definition' })] });
    const bare = (await app.inject({ method: 'POST', url: '/v1/forms', headers: as(userId), payload: { title: 'No draft' } })).json<{ id: string }>().id;
    expect((await validate(bare)).statusCode).toBe(404);
  });

  it('needs a signed-in member who may edit, and does not see another org’s forms', async () => {
    const id = await savedForm();
    expect((await app.inject({ method: 'POST', url: `/v1/forms/${id}/validate`, payload: {} })).statusCode).toBe(401);
    expect((await validate(id, as(viewerId))).statusCode).toBe(403);
    expect((await validate(id, as(otherUserId, otherOrgId))).statusCode).toBe(404);
    expect((await validate(id, as(otherUserId, orgId))).statusCode).toBe(403);
  });
});
