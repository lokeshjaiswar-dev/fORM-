import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision } from '@form/db';
import { createTestDatabase } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-2.33 review groups: who may manage them (members.manage), who may read them, who may be added (only a member whose
 * role carries submissions.review), the audit record of each write, and org isolation. The cross-org cases of every route
 * are also in the isolation suite (isolation-cases/reviews.ts); this file proves the behaviour inside one org.
 */

const BROWSER = { 'x-fr-client': 'builder', 'sec-fetch-site': 'same-origin' } as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
interface Group {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  members: Array<{ userId: string; email: string; name: string | null; role: string; canReview: boolean; addedAt: string }>;
}

let app: FastifyInstance;
let owner: pg.Pool;
let orgId: string;
let otherOrgId: string;
const user: Record<'owner' | 'admin' | 'editor' | 'creator' | 'dataCollaborator' | 'dataViewer' | 'viewer' | 'suspendedEditor' | 'otherOwner' | 'otherEditor', string> = {
  owner: randomUUID(),
  admin: randomUUID(),
  editor: randomUUID(),
  creator: randomUUID(),
  dataCollaborator: randomUUID(),
  dataViewer: randomUUID(),
  viewer: randomUUID(),
  suspendedEditor: randomUUID(),
  otherOwner: randomUUID(),
  otherEditor: randomUUID(),
};

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_review_groups');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2), ($3, $4, $4)', [orgId, 'groups-a', otherOrgId, 'groups-b']);
  const members: Array<[string, string, string, string, string]> = [
    [user.owner, 'owner', orgId, 'active', 'Olive Owner'],
    [user.admin, 'admin', orgId, 'active', 'Adam Admin'],
    [user.editor, 'editor', orgId, 'active', 'Edith Editor'],
    [user.creator, 'creator', orgId, 'active', 'Cora Creator'],
    [user.dataCollaborator, 'data_collaborator', orgId, 'active', 'Dara Collaborator'],
    [user.dataViewer, 'data_viewer', orgId, 'active', 'Dev Viewer'],
    [user.viewer, 'viewer', orgId, 'active', 'Vik Viewer'],
    [user.suspendedEditor, 'editor', orgId, 'suspended', 'Sam Suspended'],
    [user.otherOwner, 'owner', otherOrgId, 'active', 'Otto Other'],
    [user.otherEditor, 'editor', otherOrgId, 'active', 'Ella Other'],
  ];
  for (const [id, role, org, status, name] of members) {
    await owner.query('insert into users (id, email, email_norm, name) values ($1, $2, $2, $3)', [id, `${role}-${id.slice(0, 8)}@groups.test`, name]);
    await owner.query('insert into memberships (org_id, user_id, role, status) values ($1, $2, $3, $4)', [org, id, role, status]);
  }
  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'onprem',
    DATABASE_URL: urls.fr_app,
    AUTH_DEV_HEADERS: 'true',
    AUTH_SECRET: Buffer.alloc(32, 9).toString('base64url'),
    LOG_LEVEL: 'silent',
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  app = await buildApp(parsed.config, { underPressure: false });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
});

async function call(method: Method, url: string, o: { as?: string; org?: string; body?: unknown } = {}) {
  return app.inject({
    method,
    url,
    headers: { 'x-fr-dev-user': o.as ?? user.owner, 'x-fr-org': o.org ?? orgId, ...BROWSER },
    ...(o.body === undefined ? {} : { payload: o.body as Record<string, unknown> }),
  });
}

async function newGroup(name = 'Checkers', o: { as?: string; org?: string } = {}): Promise<Group> {
  const res = await call('POST', '/v1/org/review-groups', { ...o, body: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Group>();
}

const addMember = (groupId: string, userId: string, o: { as?: string; org?: string } = {}) => call('PUT', `/v1/org/review-groups/${groupId}/members/${userId}`, o);

/** The audit events of an action in an org's pending log, oldest first (the chain worker does not run in these tests). */
async function auditEvents(orgKey: string, action: string, resourceId?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `select event from audit_pending where org_key = $1 and event->>'action' = $2 and ($3::text is null or event->>'resourceId' = $3) order by id`,
    [orgKey, action, resourceId ?? null],
  );
  return rows.map((r) => r.event);
}

const memberRows = async (groupId: string) =>
  (await owner.query<{ user_id: string }>('select user_id from review_group_members where group_id = $1 order by user_id', [groupId])).rows.map((r) => r.user_id);

describe('who may manage review groups', () => {
  it('refuses a viewer’s POST with 403 and a request.authorize denied record, and makes no group', async () => {
    const before = (await owner.query('select count(*)::int as n from review_groups where org_id = $1', [orgId])).rows[0].n as number;
    const res = await call('POST', '/v1/org/review-groups', { as: user.viewer, body: { name: 'Sneaky' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user.viewer, reason: 'missing_permission:members.manage', resourceId: 'POST /v1/org/review-groups' }),
    ]);
    expect((await owner.query('select count(*)::int as n from review_groups where org_id = $1', [orgId])).rows[0].n).toBe(before);
  });

  it('refuses every write to everyone without members.manage, an editor included, and allows owner and admin', async () => {
    const group = await newGroup('Writes');
    for (const who of ['editor', 'creator', 'dataCollaborator', 'dataViewer', 'viewer'] as const) {
      const as = user[who];
      expect((await call('POST', '/v1/org/review-groups', { as, body: { name: 'No' } })).statusCode, `POST as ${who}`).toBe(403);
      expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { as, body: { name: 'No' } })).statusCode, `PATCH as ${who}`).toBe(403);
      expect((await addMember(group.id, user.editor, { as })).statusCode, `PUT member as ${who}`).toBe(403);
      expect((await call('DELETE', `/v1/org/review-groups/${group.id}/members/${user.editor}`, { as })).statusCode, `DELETE member as ${who}`).toBe(403);
    }
    expect((await newGroup('By admin', { as: user.admin })).name).toBe('By admin');
    expect((await call('GET', `/v1/org/review-groups`, { as: user.admin })).statusCode).toBe(200);
    expect((await owner.query('select name from review_groups where id = $1', [group.id])).rows).toEqual([{ name: 'Writes' }]);
  });

  it('lets a member with members.manage or submissions.review read the list, and refuses everyone else with an audited 403', async () => {
    await newGroup('Readable');
    for (const who of ['owner', 'admin', 'editor'] as const) expect((await call('GET', '/v1/org/review-groups', { as: user[who] })).statusCode, who).toBe(200);
    for (const who of ['creator', 'dataCollaborator', 'dataViewer', 'viewer'] as const) {
      const res = await call('GET', '/v1/org/review-groups', { as: user[who] });
      expect(res.statusCode, who).toBe(403);
      const { rows } = await owner.query<{ event: Record<string, unknown> }>(`select event from audit_pending where org_key = $1 and event->>'requestId' = $2`, [orgId, res.headers['x-request-id']]);
      expect(rows.map((r) => r.event), who).toEqual([
        expect.objectContaining({ action: 'request.authorize', outcome: 'denied', actorId: user[who], reason: 'missing_permission:members.manage|submissions.review' }),
      ]);
    }
  });
});

describe('creating and renaming a group', () => {
  it('creates a group with no members for the caller’s org and audits it with the name', async () => {
    const group = await newGroup('Finance checkers');
    expect(group).toMatchObject({ name: 'Finance checkers', archivedAt: null, members: [] });
    expect(group.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await owner.query('select org_id, created_by from review_groups where id = $1', [group.id])).rows).toEqual([{ org_id: orgId, created_by: user.owner }]);
    expect(await auditEvents(orgId, 'review_group.created', group.id)).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: user.owner, resourceType: 'review_group', outcome: 'success', metadata: { name: 'Finance checkers' } }),
    ]);
  });

  it('trims the name and refuses an empty, over-long or control-character name, and any other key (400)', async () => {
    expect((await newGroup('  Padded  ')).name).toBe('Padded');
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'a\u0000b' }, { name: 'tab\there' }, {}, { name: 'ok', orgId }, { name: 7 }]) {
      const res = await call('POST', '/v1/org/review-groups', { body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call('POST', '/v1/org/review-groups', { body: { name: 'x'.repeat(120) } })).statusCode).toBe(201);
  });

  it('renames a group, audits the keys that changed, and writes nothing when nothing changed', async () => {
    const group = await newGroup('Before');
    const renamed = await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { name: 'After' } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: group.id, name: 'After', archivedAt: null });
    expect(await auditEvents(orgId, 'review_group.updated', group.id)).toEqual([expect.objectContaining({ outcome: 'success', metadata: { changed: ['name'], name: 'After', archived: false } })]);

    expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { name: 'After', archived: false } })).statusCode).toBe(200);
    expect(await auditEvents(orgId, 'review_group.updated', group.id)).toHaveLength(1);
    expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: {} })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { name: '' } })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { orgId: otherOrgId, name: 'x' } })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/org/review-groups/${randomUUID()}`, { body: { name: 'x' } })).statusCode).toBe(404);
    expect((await call('PATCH', '/v1/org/review-groups/not-a-uuid', { body: { name: 'x' } })).statusCode).toBe(400);
  });

  it('archives a group and brings it back: the default list hides it, includeArchived shows it, and it takes no new checker while archived', async () => {
    const group = await newGroup('Seasonal');
    expect((await addMember(group.id, user.editor)).statusCode).toBe(200);

    const archived = await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { archived: true } });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json<Group>().archivedAt).toEqual(expect.any(String));
    expect(archived.json<Group>().members.map((m) => m.userId)).toEqual([user.editor]);
    expect(await auditEvents(orgId, 'review_group.updated', group.id)).toEqual([expect.objectContaining({ metadata: { changed: ['archived'], name: 'Seasonal', archived: true } })]);

    const ids = async (query: string) => (await call('GET', `/v1/org/review-groups${query}`)).json<{ items: Group[] }>().items.map((g) => g.id);
    expect(await ids('')).not.toContain(group.id);
    expect(await ids('?includeArchived=false')).not.toContain(group.id);
    expect(await ids('?includeArchived=true')).toContain(group.id);

    const refused = await addMember(group.id, user.admin);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'REVIEW_GROUP_ARCHIVED' });
    expect(await memberRows(group.id)).toEqual([user.editor]);
    // Taking someone out of an archived group is still allowed.
    expect((await call('DELETE', `/v1/org/review-groups/${group.id}/members/${user.editor}`)).statusCode).toBe(204);

    const back = await call('PATCH', `/v1/org/review-groups/${group.id}`, { body: { archived: false } });
    expect(back.json<Group>().archivedAt).toBeNull();
    expect(await ids('')).toContain(group.id);
    expect((await addMember(group.id, user.admin)).statusCode).toBe(200);
  });
});

describe('adding and removing checkers', () => {
  it('refuses a creator-role member with 422 NOT_A_REVIEWER, and adds an editor with a review_group.member_added record', async () => {
    const group = await newGroup('Reviewers');
    const creator = await addMember(group.id, user.creator);
    expect(creator.statusCode, creator.body).toBe(422);
    expect(creator.json()).toMatchObject({ code: 'NOT_A_REVIEWER' });
    expect(await memberRows(group.id)).toEqual([]);
    expect(await auditEvents(orgId, 'review_group.member_added', group.id)).toEqual([]);

    const editor = await addMember(group.id, user.editor);
    expect(editor.statusCode, editor.body).toBe(200);
    const view = editor.json<Group>();
    expect(view.members).toEqual([expect.objectContaining({ userId: user.editor, role: 'editor', name: 'Edith Editor', canReview: true, addedAt: expect.any(String) })]);
    expect(await memberRows(group.id)).toEqual([user.editor]);
    expect(await auditEvents(orgId, 'review_group.member_added', group.id)).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: user.owner, resourceType: 'review_group', outcome: 'success', metadata: { userId: user.editor, role: 'editor' } }),
    ]);
    expect((await owner.query('select added_by, org_id from review_group_members where group_id = $1', [group.id])).rows).toEqual([{ added_by: user.owner, org_id: orgId }]);
  });

  it('refuses every role without submissions.review, and a suspended editor, and accepts owner, admin and editor', async () => {
    const group = await newGroup('By role');
    for (const who of ['creator', 'dataCollaborator', 'dataViewer', 'viewer', 'suspendedEditor'] as const) {
      const res = await addMember(group.id, user[who]);
      expect(res.statusCode, who).toBe(422);
      expect(res.json(), who).toMatchObject({ code: 'NOT_A_REVIEWER' });
    }
    expect(await memberRows(group.id)).toEqual([]);
    for (const who of ['owner', 'admin', 'editor'] as const) expect((await addMember(group.id, user[who])).statusCode, who).toBe(200);
    expect((await memberRows(group.id)).sort()).toEqual([user.owner, user.admin, user.editor].sort());
    expect(await auditEvents(orgId, 'review_group.member_added', group.id)).toHaveLength(3);
  });

  it('answers 200 for a member already in the group, and writes no second record', async () => {
    const group = await newGroup('Twice');
    expect((await addMember(group.id, user.editor)).statusCode).toBe(200);
    const again = await addMember(group.id, user.editor);
    expect(again.statusCode).toBe(200);
    expect(again.json<Group>().members).toHaveLength(1);
    expect(await auditEvents(orgId, 'review_group.member_added', group.id)).toHaveLength(1);
  });

  it('is a 404 for a user who is not a member of the org, another org’s member included, and for a group that does not exist', async () => {
    const group = await newGroup('Org only');
    expect((await addMember(group.id, user.otherEditor)).statusCode).toBe(404);
    expect((await addMember(group.id, randomUUID())).statusCode).toBe(404);
    expect((await addMember(randomUUID(), user.editor)).statusCode).toBe(404);
    expect((await addMember(group.id, 'not-a-uuid')).statusCode).toBe(400);
    expect(await memberRows(group.id)).toEqual([]);
  });

  it('takes a member out with a review_group.member_removed record, and is idempotent for someone who is not in the group', async () => {
    const group = await newGroup('Leavers');
    await addMember(group.id, user.editor);
    await addMember(group.id, user.admin);
    const out = await call('DELETE', `/v1/org/review-groups/${group.id}/members/${user.editor}`);
    expect(out.statusCode).toBe(204);
    expect(await memberRows(group.id)).toEqual([user.admin]);
    expect(await auditEvents(orgId, 'review_group.member_removed', group.id)).toEqual([expect.objectContaining({ outcome: 'success', actorId: user.owner, metadata: { userId: user.editor } })]);

    expect((await call('DELETE', `/v1/org/review-groups/${group.id}/members/${user.editor}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/v1/org/review-groups/${group.id}/members/${randomUUID()}`)).statusCode).toBe(204);
    expect(await auditEvents(orgId, 'review_group.member_removed', group.id)).toHaveLength(1);
    expect((await call('DELETE', `/v1/org/review-groups/${randomUUID()}/members/${user.editor}`)).statusCode).toBe(404);
  });

  it('keeps a member listed, with canReview false, after their role loses submissions.review, and drops them when they leave the org', async () => {
    const group = await newGroup('Demotion');
    await addMember(group.id, user.editor);
    await owner.query(`update memberships set role = 'viewer' where org_id = $1 and user_id = $2`, [orgId, user.editor]);
    try {
      const listed = (await call('GET', '/v1/org/review-groups')).json<{ items: Group[] }>().items.find((g) => g.id === group.id)!;
      expect(listed.members).toEqual([expect.objectContaining({ userId: user.editor, role: 'viewer', canReview: false })]);
    } finally {
      await owner.query(`update memberships set role = 'editor' where org_id = $1 and user_id = $2`, [orgId, user.editor]);
    }
    const suspended = await newGroup('Suspension');
    await addMember(suspended.id, user.admin);
    await owner.query(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [orgId, user.admin]);
    try {
      const listed = (await call('GET', '/v1/org/review-groups', { as: user.owner })).json<{ items: Group[] }>().items.find((g) => g.id === suspended.id)!;
      expect(listed.members).toEqual([expect.objectContaining({ userId: user.admin, canReview: false })]);
    } finally {
      await owner.query(`update memberships set status = 'active' where org_id = $1 and user_id = $2`, [orgId, user.admin]);
    }
  });
});

describe('the list', () => {
  it('holds each group with its members, by name, and only the caller’s org’s groups', async () => {
    const b = await newGroup('Zulu list');
    const a = await newGroup('Alpha list');
    await addMember(a.id, user.editor);
    await addMember(a.id, user.owner);
    const own = (await call('GET', '/v1/org/review-groups')).json<{ items: Group[] }>().items;
    const names = own.map((g) => g.name);
    expect(names.indexOf('Alpha list')).toBeLessThan(names.indexOf('Zulu list'));
    expect(own.find((g) => g.id === a.id)!.members.map((m) => m.email)).toEqual([...own.find((g) => g.id === a.id)!.members.map((m) => m.email)].sort());
    expect(own.find((g) => g.id === b.id)!.members).toEqual([]);
    const other = await newGroup('Other org group', { as: user.otherOwner, org: otherOrgId });
    expect(own.map((g) => g.id)).not.toContain(other.id);
    const theirs = (await call('GET', '/v1/org/review-groups', { as: user.otherOwner, org: otherOrgId })).json<{ items: Group[] }>().items;
    expect(theirs.map((g) => g.id)).toEqual([other.id]);
  });

  it('is not cached', async () => {
    expect((await call('GET', '/v1/org/review-groups')).headers['cache-control']).toBe('no-store');
  });
});

describe('another org', () => {
  it('cannot see, rename, archive or change the members of this org’s group: 404, and nothing changes', async () => {
    const group = await newGroup('Private');
    await addMember(group.id, user.editor);
    const as = { as: user.otherOwner, org: otherOrgId };
    const listed = (await call('GET', '/v1/org/review-groups?includeArchived=true', as)).json<{ items: Group[] }>().items;
    expect(listed.map((g) => g.id)).not.toContain(group.id);
    expect(JSON.stringify(listed)).not.toContain('Private');
    expect((await call('PATCH', `/v1/org/review-groups/${group.id}`, { ...as, body: { name: 'Taken', archived: true } })).statusCode).toBe(404);
    expect((await addMember(group.id, user.otherEditor, as)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/org/review-groups/${group.id}/members/${user.editor}`, as)).statusCode).toBe(404);
    expect((await owner.query('select name, archived_at from review_groups where id = $1', [group.id])).rows).toEqual([{ name: 'Private', archived_at: null }]);
    expect(await memberRows(group.id)).toEqual([user.editor]);
  });

  it('cannot put this org’s member into its own group, or name this org’s header with its own user: 404, then 403', async () => {
    const mine = await newGroup('Theirs', { as: user.otherOwner, org: otherOrgId });
    expect((await addMember(mine.id, user.editor, { as: user.otherOwner, org: otherOrgId })).statusCode).toBe(404);
    expect(await memberRows(mine.id)).toEqual([]);
    const naming = await call('GET', '/v1/org/review-groups', { as: user.otherOwner, org: orgId });
    expect(naming.statusCode).toBe(403);
  });
});
