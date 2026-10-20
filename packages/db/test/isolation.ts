import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { ACTOR_KINDS, withTenant, type TenantCtx } from '../src/index.ts';
import { failure, pgCode, type OrgSeed, type Seed, type TestDb } from './harness.ts';

/** An actor of org B; every isolation case runs as each of them (architecture §2.3). */
export interface Actor {
  kind: TenantCtx['actor'];
  ctx(b: OrgSeed): Omit<TenantCtx, 'requestId'>;
}

export const ACTORS: Actor[] = [
  { kind: 'user', ctx: (b) => ({ orgId: b.orgId, actor: 'user', userId: b.editorId, perms: ['forms.read', 'forms.edit'], teamIds: [b.teamId] }) },
  { kind: 'api_key', ctx: (b) => ({ orgId: b.orgId, actor: 'api_key', perms: ['forms.read'] }) },
  { kind: 'system', ctx: (b) => ({ orgId: b.orgId, actor: 'system', perms: [] }) },
  { kind: 'respondent', ctx: (b) => ({ orgId: b.orgId, actor: 'respondent', subjectIds: [randomUUID()] }) },
  { kind: 'platform', ctx: (b) => ({ orgId: b.orgId, actor: 'platform', perms: [] }) },
];

type Denied = 'denied';
type Outcome = 0 | Denied;

/**
 * How a table's rows belong to an org: `org` rows carry the org id in `column` (org_id by default); `user` rows
 * belong to a person (`column` user_id by default: org A's users' rows are the foreign ones).
 */
export type Scope = { by: 'org'; column?: string } | { by: 'user'; column?: string } | { by: 'custom'; foreign: (s: Seed) => SQL; own?: (s: Seed) => SQL };

export interface TableSpec {
  scope: Scope;
  /** What org B's actors get from a SELECT: none of org A's rows (0), or a permission error. */
  select: Outcome;
  /** A column fr_app may update: the generated UPDATE aimed at org A's rows sets it to itself. */
  touch?: string;
  update: Outcome;
  delete: Outcome;
  /** Actor kinds that see rows of their own org at all; the others see none. Default: every kind. */
  visibleTo?: readonly TenantCtx['actor'][];
  /** Replaces the generated INSERT of a row for org A (default: a copy of one of org B's rows, re-pointed at org A). */
  insertForeign?: (s: Seed) => SQL;
}

const column = (scope: Scope) => (scope.by === 'custom' ? null : (scope.column ?? (scope.by === 'org' ? 'org_id' : 'user_id')));

function foreignWhere(scope: Scope, s: Seed): SQL {
  if (scope.by === 'custom') return scope.foreign(s);
  const c = sql.identifier(column(scope)!);
  return scope.by === 'org' ? sql`${c} = ${s.a.orgId}` : sql`${c} in (${s.a.ownerId}, ${s.a.editorId})`;
}

function ownWhere(scope: Scope, s: Seed): SQL | null {
  if (scope.by === 'custom') return scope.own?.(s) ?? null;
  const c = sql.identifier(column(scope)!);
  return scope.by === 'org' ? sql`${c} = ${s.b.orgId}` : sql`${c} in (${s.b.ownerId}, ${s.b.editorId})`;
}

async function count(t: TestDb, ctx: Omit<TenantCtx, 'requestId'>, table: string, where: SQL): Promise<number> {
  return withTenant(t.app.db, { ...ctx, requestId: 'isolation', readOnly: true }, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`);
    return rows[0]!.n;
  });
}

/**
 * The generated INSERT for org A: one of org B's rows (read as the owner) re-pointed at org A, restricted to the
 * columns fr_app may insert. RLS checks WITH CHECK before constraints, so the only acceptable answer is 42501.
 * Without a row of org B, the scope column alone.
 */
async function generatedInsert(t: TestDb, table: string, scope: Scope, s: Seed): Promise<SQL> {
  const col = column(scope);
  if (!col) throw new Error(`isolation: ${table} has a custom scope and needs insertForeign`);
  const target = scope.by === 'org' ? s.a.orgId : s.a.editorId;
  const own = ownWhere(scope, s)!;
  const { rows: cols } = await t.owner.query<{ name: string }>(
    `select p.column_name as name from information_schema.column_privileges p
     join information_schema.columns c on c.table_schema = p.table_schema and c.table_name = p.table_name and c.column_name = p.column_name
     where p.table_schema = 'public' and p.table_name = $1 and p.grantee = 'fr_app' and p.privilege_type = 'INSERT'
       and c.is_identity = 'NO' and c.is_generated = 'NEVER'
     order by c.ordinal_position`,
    [table],
  );
  const names = [...new Set([col, ...cols.map((c) => c.name)])];
  const { rows } = await drizzle({ client: t.owner }).execute<{ row: Record<string, unknown> }>(
    sql`select to_jsonb(t) as row from ${sql.identifier(table)} t where ${own} limit 1`,
  );
  const list = sql.join(
    names.map((n) => sql.identifier(n)),
    sql`, `,
  );
  if (!rows[0]) return sql`insert into ${sql.identifier(table)} (${sql.identifier(col)}) values (${target})`;
  const row = { ...rows[0].row, [col]: target, ...('id' in rows[0].row && col !== 'id' ? { id: randomUUID() } : {}) };
  return sql`insert into ${sql.identifier(table)} (${list}) select ${list} from jsonb_populate_record(null::${sql.identifier(table)}, ${JSON.stringify(row)}::jsonb)`;
}

async function outcome(run: Promise<{ rowCount: number | null }>, expected: Outcome): Promise<void> {
  if (expected === 0) expect((await run).rowCount).toBe(0);
  else expect(pgCode(await failure(run))).toBe('42501');
}

/** `isolation('forms', spec, env)`: org B's actors can neither read, change, delete nor create org A's rows, and nothing raises. */
export function isolation(table: string, spec: TableSpec, env: () => { t: TestDb; seed: Seed }): void {
  describe(`isolation: ${table}`, () => {
    for (const actor of ACTORS) {
      describe(`as ${actor.kind}`, () => {
        it(spec.select === 0 ? 'sees none of the other org’s rows, and its own' : 'cannot read the table', async () => {
          const { t, seed } = env();
          const ctx = actor.ctx(seed.b);
          if (spec.select === 'denied') {
            expect(pgCode(await failure(count(t, ctx, table, sql`true`)))).toBe('42501');
            return;
          }
          expect(await count(t, ctx, table, foreignWhere(spec.scope, seed))).toBe(0);
          if (spec.visibleTo && !spec.visibleTo.includes(actor.kind)) {
            expect(await count(t, ctx, table, sql`true`)).toBe(0);
            return;
          }
          expect(await count(t, ctx, table, sql`true`)).toBeGreaterThan(0);
          const own = ownWhere(spec.scope, seed);
          if (own) expect(await count(t, ctx, table, own)).toBeGreaterThan(0);
        });

        it(spec.update === 0 ? 'updates none of the other org’s rows' : 'cannot update the table', async () => {
          const { t, seed } = env();
          const c = sql.identifier(spec.touch ?? column(spec.scope) ?? 'id');
          const run = withTenant(t.app.db, { ...actor.ctx(seed.b), requestId: 'isolation' }, (tx) =>
            tx.execute(sql`update ${sql.identifier(table)} set ${c} = ${c} where ${foreignWhere(spec.scope, seed)}`),
          );
          await outcome(run, spec.update);
        });

        it(spec.delete === 0 ? 'deletes none of the other org’s rows' : 'cannot delete from the table', async () => {
          const { t, seed } = env();
          const run = withTenant(t.app.db, { ...actor.ctx(seed.b), requestId: 'isolation' }, (tx) =>
            tx.execute(sql`delete from ${sql.identifier(table)} where ${foreignWhere(spec.scope, seed)}`),
          );
          await outcome(run, spec.delete);
        });

        it('cannot insert a row for the other org', async () => {
          const { t, seed } = env();
          const insert = spec.insertForeign?.(seed) ?? (await generatedInsert(t, table, spec.scope, seed));
          const run = withTenant(t.app.db, { ...actor.ctx(seed.b), requestId: 'isolation' }, (tx) => tx.execute(insert));
          expect(pgCode(await failure(run))).toBe('42501');
        });
      });
    }
  });
}

/** Generates the suite for every table of `specs` and every actor kind. */
export function isolationSuite(specs: Record<string, TableSpec>, env: () => { t: TestDb; seed: Seed }): void {
  expect(ACTORS.map((a) => a.kind).sort()).toEqual([...ACTOR_KINDS].sort());
  for (const [table, spec] of Object.entries(specs)) isolation(table, spec, env);
}

/** Tables in public (no partitions): each needs a spec, so a new table cannot ship without its isolation suite. */
export async function publicTables(t: TestDb): Promise<string[]> {
  const { rows } = await t.owner.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`,
  );
  return rows.map((r) => r.name);
}
