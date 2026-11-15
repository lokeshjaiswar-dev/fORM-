import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertSubmission, newSubmission, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

/** `tools/audit/guest-published-versions.sql`: two read-only SELECTs for finding what the anonymous publish route left. */
const QUERY = readFileSync(fileURLToPath(new URL('../../../tools/audit/guest-published-versions.sql', import.meta.url)), 'utf8');

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

interface VersionRow {
  version_id: string;
  in_guest_window: boolean;
  same_transaction_as_form: boolean;
  same_transaction_as_draft: boolean;
  no_publish_event: boolean;
  has_submissions: boolean;
  published_by_email: string | null;
}

/** What `guest_publish_form()` did (0015): the form, its draft and the version, written in one transaction under the org owner. */
async function guestPublish(): Promise<{ formId: string; versionId: string }> {
  const formId = randomUUID();
  const versionId = randomUUID();
  const c = await t.owner.connect();
  try {
    await c.query('begin');
    await c.query(`insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $2, $3, 'Win a prize')`, [formId, seed.a.orgId, seed.a.ownerId]);
    await c.query(
      `insert into form_drafts (form_id, org_id, draft, draft_rev, schema_version, size_bytes, updated_by, updated_at) values ($1, $2, '{}', 1, 2, 2, $3, now())`,
      [formId, seed.a.orgId, seed.a.ownerId],
    );
    await c.query(
      `insert into form_versions (id, org_id, form_id, number, schema_version, published_at, published_by, definition, compiled, content_hash)
       values ($1, $2, $3, 1, 2, now(), $4, '{}', '{}', '0')`,
      [versionId, seed.a.orgId, formId, seed.a.ownerId],
    );
    await c.query(`update forms set live_version_id = $1, slug = $2 where id = $3`, [versionId, `win-${formId.slice(0, 8)}`, formId]);
    await c.query('commit');
  } finally {
    c.release();
  }
  return { formId, versionId };
}

/** What the member route does: the form and the draft exist from earlier requests, and the version is written later. */
async function memberPublish(withEvent: boolean): Promise<{ formId: string; versionId: string }> {
  const formId = randomUUID();
  const versionId = randomUUID();
  await t.owner.query(`insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $2, $3, 'Real form')`, [formId, seed.a.orgId, seed.a.ownerId]);
  await t.owner.query(`insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by) values ($1, $2, '{}', 2, 2, $3)`, [formId, seed.a.orgId, seed.a.ownerId]);
  await t.owner.query('select pg_sleep(0.01)');
  await t.owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash)
     values ($1, $2, $3, 1, 2, $4, '{}', '{}', '0')`,
    [versionId, seed.a.orgId, formId, seed.a.editorId],
  );
  if (withEvent) {
    await t.owner.query(`insert into audit_pending (org_key, event) values ($1, $2)`, [
      seed.a.orgId,
      JSON.stringify({ actorKind: 'user', action: 'form.published', resourceType: 'form_version', resourceId: versionId, outcome: 'success' }),
    ]);
  }
  return { formId, versionId };
}

/** The query, run the way the runbook runs it, but inside a read-only transaction so any write would fail. */
async function run(): Promise<{ versions: VersionRow[]; drafts: Array<{ form_id: string; version_id: string }> }> {
  const c: pg.PoolClient = await t.owner.connect();
  try {
    await c.query('begin read only');
    const results = (await c.query(QUERY)) as unknown as Array<pg.QueryResult>;
    await c.query('rollback');
    expect(results).toHaveLength(2);
    return { versions: results[0]!.rows as VersionRow[], drafts: results[1]!.rows as Array<{ form_id: string; version_id: string }> };
  } finally {
    c.release();
  }
}

describe('tools/audit/guest-published-versions.sql', () => {
  it('only reads: it runs inside a read-only transaction', async () => {
    await run();
    const statements = QUERY.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(2);
    for (const s of statements) expect(s).toMatch(/^select\b/i);
  });

  it('flags a version the guest function wrote: same transaction as its form and draft, inside the window it was open', async () => {
    // The 0014 .. 0016 window, as a deployment that ran those builds would have it.
    await t.owner.query(`update fr_meta.schema_migrations set applied_at = now() - interval '2 days' where version = 14`);
    await t.owner.query(`update fr_meta.schema_migrations set applied_at = now() + interval '1 day' where version = 16`);
    const guest = await guestPublish();
    const { versions, drafts } = await run();
    const row = versions.find((v) => v.version_id === guest.versionId);
    expect(row).toMatchObject({ in_guest_window: true, same_transaction_as_form: true, same_transaction_as_draft: true, no_publish_event: true, has_submissions: false });
    expect(row?.published_by_email).toEqual(expect.any(String));
    // Listed first: in the window and same-transaction rows lead.
    expect(versions[0]?.version_id).toBe(guest.versionId);
    expect(drafts.map((d) => d.version_id)).toContain(guest.versionId);
  });

  it('lists a member-published version without an event as a candidate only, and leaves out one with its form.published event', async () => {
    const unrecorded = await memberPublish(false);
    const recorded = await memberPublish(true);
    const { versions, drafts } = await run();
    expect(versions.find((v) => v.version_id === unrecorded.versionId)).toMatchObject({ in_guest_window: true, same_transaction_as_form: false, same_transaction_as_draft: false });
    expect(versions.map((v) => v.version_id)).not.toContain(recorded.versionId);
    expect(drafts.map((d) => d.form_id)).not.toContain(unrecorded.formId);
  });

  it('says a version published after migration 0016 is outside the window, whatever its timestamps', async () => {
    await t.owner.query(`update fr_meta.schema_migrations set applied_at = now() - interval '1 hour' where version = 16`);
    const late = await guestPublish();
    const { versions } = await run();
    expect(versions.find((v) => v.version_id === late.versionId)).toMatchObject({ in_guest_window: false });
  });

  it('reports submissions the form already took', async () => {
    const guest = await guestPublish();
    await insertSubmission(t.owner, newSubmission({ orgId: seed.a.orgId, formIds: [guest.formId, guest.formId], versionIds: [guest.versionId, guest.versionId] }, 0, { answers: {} }));
    const { versions } = await run();
    expect(versions.find((v) => v.version_id === guest.versionId)).toMatchObject({ has_submissions: true });
  });
});
