import { randomUUID } from 'node:crypto';
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
    teamId: randomUUID(),
    formIds: [randomUUID(), randomUUID()],
  };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [s.orgId, slug, `Org ${slug}`]);
  for (const [id, who] of [
    [s.ownerId, 'owner'],
    [s.editorId, 'editor'],
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
    `insert into audit_log (org_id, seq, occurred_at, actor_kind, actor_id, action, resource_type, resource_id, outcome, prev_hash, hash)
     values ($1, 1, now(), 'user', $2, 'form.created', 'form', $3, 'success', $4, $4)`,
    [s.orgId, s.ownerId, s.formIds[0], HASH],
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
