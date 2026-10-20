import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createTestDatabase } from '@form/testkit';
import { createDb, provision, type DbHandle, type RoleName } from '../src/index.ts';
import { TEST_PASSWORDS } from './passwords.ts';

export interface TestDb {
  database: string;
  urls: Record<RoleName, string>;
  /** Pool as fr_app (NOBYPASSRLS), the role request traffic uses. */
  app: DbHandle;
  /** Pool as fr_migrator (schema owner, BYPASSRLS), for seeding and inspection. */
  owner: pg.Pool;
  close(): Promise<void>;
}

/** A fresh database with every migration applied. */
export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl);
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  const app = createDb(urls.fr_app, { max: 4, applicationName: 'fr-test' });
  const owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
  return {
    database,
    urls,
    app,
    owner,
    close: async () => {
      await app.close();
      await owner.end();
    },
  };
}

export interface OrgSeed {
  orgId: string;
  ownerId: string;
  editorId: string;
  viewerId: string;
  teamId: string;
  formIds: [string, string];
}

export interface Seed {
  a: OrgSeed;
  b: OrgSeed;
}

const HASH = Buffer.alloc(32);

async function seedOrg(owner: pg.Pool, slug: string): Promise<OrgSeed> {
  const s: OrgSeed = {
    orgId: randomUUID(),
    ownerId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    teamId: randomUUID(),
    formIds: [randomUUID(), randomUUID()],
  };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [s.orgId, slug, `Org ${slug}`]);
  await owner.query('insert into org_settings (org_id) values ($1)', [s.orgId]);
  for (const [id, who] of [
    [s.ownerId, 'owner'],
    [s.editorId, 'editor'],
    [s.viewerId, 'viewer'],
  ] as const) {
    await owner.query('insert into users (id, email, email_norm, password_hash) values ($1, $2, $2, $3)', [id, `${who}@${slug}.test`, 'argon2id$secret']);
    await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [s.orgId, id, who]);
  }
  for (const [i, formId] of s.formIds.entries()) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [
      formId,
      s.orgId,
      s.teamId,
      s.ownerId,
      `${slug} form ${i + 1}`,
    ]);
    await owner.query(
      `insert into form_drafts (form_id, org_id, draft, schema_version, size_bytes, updated_by) values ($1, $2, '{"blocks":[]}', 2, 13, $3)`,
      [formId, s.orgId, s.ownerId],
    );
  }
  await owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, 'pwd', now() + interval '1 hour', now() + interval '1 day')`,
    [randomUUID(), randomBytes(32), s.editorId],
  );
  await owner.query(`insert into user_identities (id, user_id, provider, subject) values ($1, $2, 'google', $3)`, [randomUUID(), s.editorId, `sub-${s.editorId}`]);
  await owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values ($1, $2, 'magic_link', $3, now() + interval '15 minutes')`, [
    randomUUID(),
    randomBytes(32),
    s.editorId,
  ]);
  await owner.query(
    `insert into user_notice_acks (id, user_id, notice_version, notice_hash, locale, context) values ($1, $2, '2026-10-19', $3, 'en-IN', 'signup')`,
    [randomUUID(), s.editorId, randomBytes(32)],
  );
  await owner.query(
    `insert into user_grievances (id, user_id, reference, category, message, due_at) values ($1, $2, $3, 'information', 'What do you hold?', now() + interval '90 days')`,
    [randomUUID(), s.editorId, `GRV-${randomBytes(5).toString('hex').slice(0, 8).toUpperCase().replace(/[01890]/g, 'A')}`],
  );
  await owner.query(
    `insert into invites (id, org_id, email, email_norm, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $3, 'viewer', $4, $5, now() + interval '7 days')`,
    [randomUUID(), s.orgId, `invitee@${slug}.test`, randomBytes(32), s.ownerId],
  );
  await owner.query(
    `insert into audit_log (org_id, seq, occurred_at, actor_kind, actor_id, action, resource_type, resource_id, outcome, prev_hash, hash)
     values ($1, 1, now(), 'user', $2, 'form.created', 'form', $3, 'success', $4, $4)`,
    [s.orgId, s.ownerId, s.formIds[0], HASH],
  );
  await owner.query(
    `insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature) values ($1, 1, $2, now(), 'test', 'ed25519', $3)`,
    [s.orgId, HASH, Buffer.alloc(64)],
  );
  await owner.query(
    `insert into audit_archives (org_key, month, object_key, row_count, min_seq, max_seq, sha256) values ($1, '2020-01', 'archive/x', 1, 1, 1, $2)`,
    [s.orgId, HASH],
  );
  return s;
}

export async function seedTwoOrgs(owner: pg.Pool): Promise<Seed> {
  const tag = randomUUID().slice(0, 8);
  return { a: await seedOrg(owner, `a-${tag}`), b: await seedOrg(owner, `b-${tag}`) };
}

/** The SQLSTATE of a pg error, also when drizzle wraps it. */
export function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected the statement to fail');
    },
    (err: unknown) => err,
  );
}
