import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { draftWith, fieldBlock } from '../publishable-draft.ts';
import type { Fixture, IsolationCase, IsolationDomain, Res, SeedEnv } from './types.ts';

/*
 * The cases of every route that existed before the per-domain files (WP-1.06 scaffold). A work package that rewrites one
 * of these routes moves its case to its own domain file and deletes it here, which the suite's duplicate check enforces.
 *
 * The fixture is seeded the way rows really arrive (the API as a member, the public routes as a respondent), not with
 * INSERTs into the tables a later work package is about to change, so schema work does not break the suite.
 */

const ANSWER = 'Acme private answer 7f3a';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();
const itemsOf = (res: Res, key = 'items') => (bodyOf(res)[key] as Array<Record<string, unknown>>) ?? [];
const sha256 = (text: string) => createHash('sha256').update(text).digest();

async function createUser(env: SeedEnv, email: string): Promise<string> {
  const id = randomUUID();
  await env.owner.query('insert into users (id, email, email_norm, name, email_verified_at) values ($1, $2, $2, $3, now())', [id, email, `User ${email.split('@')[0]}`]);
  return id;
}

async function createOrg(env: SeedEnv, slug: string, name: string, members: Array<[string, string]>): Promise<string> {
  const id = randomUUID();
  await env.owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [id, slug, name]);
  for (const [userId, role] of members) await env.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [id, userId, role]);
  return id;
}

async function ok<T>(res: Res | Promise<Res>, status = 200): Promise<T> {
  const r = await res;
  if (r.statusCode !== status) throw new Error(`seed: expected ${status}, got ${r.statusCode} ${r.body}`);
  return r.json<T>();
}

/** The first save of a form's draft: `If-Match: 0` says "no draft yet" (a draft write without it is a 428). */
function putFirstDraft(env: SeedEnv, userId: string, orgId: string, formId: string, draft: unknown): Promise<Res> {
  return env.app.inject({
    method: 'PUT',
    url: `/v1/forms/${formId}/draft`,
    headers: { 'x-fr-dev-user': userId, 'x-fr-org': orgId, 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin', 'if-match': '0' },
    payload: { draft } as Record<string, unknown>,
  });
}

/** Org A, the victim, with every kind of row the routes below can name; org B, the caller, with one form. */
export async function seedCore(env: SeedEnv): Promise<Fixture> {
  const aOwner = await createUser(env, 'owner@iso-a.test');
  const aMember = await createUser(env, 'member@iso-a.test');
  const bOwner = await createUser(env, 'owner@iso-b.test');
  const aOrg = await createOrg(env, 'iso-org-a', 'Org A (isolation)', [
    [aOwner, 'owner'],
    [aMember, 'editor'],
  ]);
  const bOrg = await createOrg(env, 'iso-org-b', 'Org B (isolation)', [[bOwner, 'owner']]);

  const formTitle = 'Acme intake 7f3a';
  const fields = () => [fieldBlock('name', 'short_text', {}, { required: true }), fieldBlock('cv', 'file_upload', { accept: { extensions: ['pdf'], mimeTypes: ['application/pdf'] } })];
  const { id: formId } = await ok<{ id: string }>(env.as(aOwner, aOrg, 'POST', '/v1/forms', { title: formTitle }));
  await ok(putFirstDraft(env, aOwner, aOrg, formId, draftWith(formId, fields(), formTitle)));
  const live = await ok<{ slug: string; versionId: string }>(env.as(aOwner, aOrg, 'POST', `/v1/forms/${formId}/publish`, {}));
  const { id: secondFormId } = await ok<{ id: string }>(env.as(aOwner, aOrg, 'POST', '/v1/forms', { title: 'Acme second 7f3a' }));
  await ok(putFirstDraft(env, aOwner, aOrg, secondFormId, draftWith(secondFormId, fields(), 'Acme second 7f3a')));

  // A respondent's answer and file reach the form the way they really do, through the public routes.
  const submitted = await ok<{ ok: true; submissionId: string }>(
    env.app.inject({
      method: 'POST',
      url: `/v1/p/${live.slug}/submissions`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { formVersionId: live.versionId, answers: { name: { type: 'short_text', value: ANSWER } }, fields: [], locale: 'en-IN' },
    }),
  );
  const file = await ok<{ fileId: string }>(
    env.app.inject({ method: 'POST', url: `/v1/p/${live.slug}/files`, payload: { blockId: 'cv', name: 'cv.pdf', mime: 'application/pdf', data: PDF.toString('base64') } }),
  );

  const inviteId = randomUUID();
  const inviteToken = randomBytes(32).toString('base64url');
  const inviteEmail = 'newcomer@iso-a.test';
  await env.owner.query(
    `insert into invites (id, org_id, email, email_norm, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $3, 'viewer', $4, $5, now() + interval '7 days')`,
    [inviteId, aOrg, inviteEmail, sha256(inviteToken), aOwner],
  );
  const sessionId = randomUUID();
  await env.owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at) values ($1, $2, $3, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    [sessionId, sha256(randomBytes(32).toString('base64url')), aOwner],
  );

  const { id: bFormId } = await ok<{ id: string }>(env.as(bOwner, bOrg, 'POST', '/v1/forms', { title: 'Org B form' }));
  const notice = await ok<{ version: string; hash: string }>(env.app.inject({ url: '/v1/privacy/notice' }));

  const a: Fixture['a'] = {
    orgId: aOrg,
    slug: 'iso-org-a',
    name: 'Org A (isolation)',
    ownerId: aOwner,
    ownerEmail: 'owner@iso-a.test',
    memberId: aMember,
    memberEmail: 'member@iso-a.test',
    formId,
    formTitle,
    secondFormId,
    versionId: live.versionId,
    formSlug: live.slug,
    submissionId: submitted.submissionId,
    fileId: file.fileId,
    inviteId,
    inviteToken,
    inviteEmail,
    sessionId,
  };
  return {
    a,
    b: { orgId: bOrg, slug: 'iso-org-b', ownerId: bOwner, formId: bFormId },
    notice: { version: notice.version, hash: notice.hash },
    extra: {},
    secrets: [...Object.values(a), 'Acme second 7f3a', ANSWER],
  };
}

const forms: IsolationCase[] = [
  // GET and POST /v1/forms, the draft routes and the merge moved to forms.ts, with the rest of WP-1.06.
  // The live, publish and validate cases moved to publish.ts, with the rest of WP-1.07.
  { route: 'GET /v1/forms/:formId/submissions', call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions` }) },
  { route: 'GET /v1/forms/:formId/submissions/:id', call: (f) => ({ url: `/v1/forms/${f.a.formId}/submissions/${f.a.submissionId}` }) },
  { route: 'GET /v1/forms/:formId/files/:id', call: (f) => ({ url: `/v1/forms/${f.a.formId}/files/${f.a.fileId}` }) },
];

const org: IsolationCase[] = [
  {
    route: 'GET /v1/org',
    call: () => ({ url: '/v1/org' }),
    own: { status: 200, check: (res, _f, actor) => expect((bodyOf(res).org as { id: string }).id).toBe(actor.orgId) },
  },
  {
    route: 'PATCH /v1/org',
    call: () => ({ url: '/v1/org', body: { name: 'Renamed by a member' } }),
    own: { status: 200, check: (res, _f, actor) => expect((bodyOf(res).org as { id: string }).id).toBe(actor.orgId) },
    note: 'The org is the caller’s own; the route takes no id, so org A cannot be named at all.',
  },
  { route: 'GET /v1/org/settings', call: () => ({ url: '/v1/org/settings' }), own: { status: 200 } },
  { route: 'PATCH /v1/org/settings', call: () => ({ url: '/v1/org/settings', body: { inviteDays: 5 } }), own: { status: 200 } },
  {
    route: 'GET /v1/org/members',
    call: () => ({ url: '/v1/org/members' }),
    own: {
      status: 200,
      check: (res, f, actor) => {
        const ids = itemsOf(res).map((m) => m.userId);
        expect(ids).toContain(actor.id);
        expect(ids).not.toContain(f.a.ownerId);
        expect(ids).not.toContain(f.a.memberId);
      },
    },
  },
  { route: 'PATCH /v1/org/members/:userId', call: (f) => ({ url: `/v1/org/members/${f.a.memberId}`, body: { role: 'viewer' } }) },
  { route: 'DELETE /v1/org/members/:userId', call: (f) => ({ url: `/v1/org/members/${f.a.memberId}` }) },
  { route: 'POST /v1/org/members/:userId/access-link', call: (f) => ({ url: `/v1/org/members/${f.a.memberId}/access-link` }) },
  { route: 'GET /v1/org/invites', call: () => ({ url: '/v1/org/invites' }), own: { status: 200, check: (res, f) => expect(itemsOf(res).map((i) => i.id)).not.toContain(f.a.inviteId) } },
  {
    route: 'POST /v1/org/invites',
    call: (f) => ({ url: '/v1/org/invites', body: { email: f.a.memberEmail, role: 'viewer' } }),
    own: { status: 201 },
    note: 'Org A’s member is invisible to org B: inviting their address works and says nothing (no ALREADY_MEMBER) about org A’s membership.',
  },
  { route: 'DELETE /v1/org/invites/:id', call: (f) => ({ url: `/v1/org/invites/${f.a.inviteId}` }) },
];

const account: IsolationCase[] = [
  {
    route: 'GET /v1/orgs',
    call: () => ({ url: '/v1/orgs' }),
    own: { status: 200, check: (res, _f, actor) => expect(itemsOf(res).map((o) => o.id)).toEqual([actor.orgId]) },
  },
  {
    route: 'POST /v1/orgs',
    call: (f) => ({ url: '/v1/orgs', body: { name: 'Org A again', slug: f.a.slug } }),
    own: { status: 409, code: 'SLUG_TAKEN' },
    note: 'An org address is public and globally unique, so a taken address is not a secret; no second org is created.',
  },
  {
    route: 'PUT /v1/me/active-org',
    call: (f) => ({ url: '/v1/me/active-org', body: { orgId: f.a.orgId } }),
    own: {
      status: 403,
      code: 'FORBIDDEN',
      audit: (f) => ({ orgKey: 'platform', action: 'request.authorize', outcome: 'denied', reason: 'not_a_member', metadata: { claimedOrgId: f.a.orgId } }),
    },
  },
  {
    route: 'POST /v1/invites/accept',
    call: (f) => ({ url: '/v1/invites/accept', body: { token: f.a.inviteToken } }),
    own: { status: 403, code: 'INVITE_EMAIL_MISMATCH', audit: { orgKey: 'a', action: 'member.joined', outcome: 'denied', reason: 'email_mismatch' } },
    note: 'An invite is for one verified address; org B’s member holding org A’s token joins nothing, and org A’s chain records the refusal.',
  },
  { route: 'GET /v1/me', call: () => ({ url: '/v1/me' }), own: { status: 200 } },
  { route: 'PATCH /v1/me', call: () => ({ url: '/v1/me', body: { name: 'Changed by the isolation suite' } }), own: { status: 200 } },
  {
    route: 'POST /v1/me/notice',
    call: (f) => ({ url: '/v1/me/notice', body: { version: f.notice.version, hash: f.notice.hash } }),
    own: { status: 200 },
  },
  { route: 'POST /v1/me/export', call: () => ({ url: '/v1/me/export' }), own: { status: 200 } },
  { route: 'GET /v1/me/deletion', call: () => ({ url: '/v1/me/deletion' }), own: { status: 200 } },
  {
    route: 'POST /v1/me/delete',
    call: (_f, actor) => ({ url: '/v1/me/delete', body: { confirmEmail: actor.email } }),
    own: { status: 200 },
    note: 'The caller deletes their own account (org B keeps another owner); org A’s members and rows stay as they were.',
  },
  { route: 'GET /v1/me/grievances', call: () => ({ url: '/v1/me/grievances' }), own: { status: 200 } },
  { route: 'POST /v1/me/grievances', call: () => ({ url: '/v1/me/grievances', body: { category: 'other', message: 'A question from the isolation suite' } }), own: { status: 201 } },
  {
    route: 'GET /v1/me/sessions',
    call: () => ({ url: '/v1/me/sessions' }),
    own: { status: 200, check: (res, _f, actor) => expect(itemsOf(res).map((s) => s.id)).toEqual([actor.sessionId]) },
  },
  { route: 'DELETE /v1/me/sessions/:id', call: (f) => ({ url: `/v1/me/sessions/${f.a.sessionId}` }) },
  { route: 'POST /v1/auth/logout', call: () => ({ url: '/v1/auth/logout' }), own: { status: 204 } },
  { route: 'POST /v1/auth/mfa/totp/setup', call: () => ({ url: '/v1/auth/mfa/totp/setup' }), own: { status: 200 } },
  { route: 'POST /v1/auth/mfa/totp/verify', call: () => ({ url: '/v1/auth/mfa/totp/verify', body: { code: '123456' } }), own: { status: 409, code: 'MFA_NOT_ENABLED' } },
  { route: 'POST /v1/auth/mfa/totp/disable', call: () => ({ url: '/v1/auth/mfa/totp/disable', body: { code: '123456' } }), own: { status: 409, code: 'MFA_NOT_ENABLED' } },
  { route: 'POST /v1/auth/mfa/recovery-codes', call: () => ({ url: '/v1/auth/mfa/recovery-codes', body: { code: '123456' } }), own: { status: 409, code: 'MFA_NOT_ENABLED' } },
];

export const CORE_ISOLATION: IsolationDomain = { cases: [...forms, ...org, ...account] };
