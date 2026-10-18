import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTenant, type TenantCtx } from '../src/index.ts';
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
];

type Denied = 'denied';

export interface IsolationCase {
  /** Rows of org A, as a where clause. */
  foreign: (s: Seed) => SQL;
  /** Rows of org B every actor kind can read; omit when fr_app may not read the table at all. */
  own?: (s: Seed) => SQL;
  /** An UPDATE aimed at org A's rows: touches nothing, or is denied outright. */
  update?: (s: Seed) => SQL;
  /** An INSERT of a row for org A. */
  insertForeign: (s: Seed) => SQL;
  expect: { select: 0 | Denied; update?: 0 | Denied };
}

async function count(t: TestDb, ctx: Omit<TenantCtx, 'requestId'>, table: string, where: SQL): Promise<number> {
  return withTenant(t.app.db, { ...ctx, requestId: 'isolation', readOnly: true }, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`);
    return rows[0]!.n;
  });
}

/** `isolation('forms', {...})`: org B's actors can neither read, change nor create org A's rows, and nothing raises. */
export function isolation(table: string, c: IsolationCase, env: () => { t: TestDb; seed: Seed }): void {
  describe(`isolation: ${table}`, () => {
    for (const actor of ACTORS) {
      describe(`as ${actor.kind}`, () => {
        it(c.expect.select === 0 ? 'sees none of the other org’s rows, and its own' : 'cannot read the table', async () => {
          const { t, seed } = env();
          const ctx = actor.ctx(seed.b);
          if (c.expect.select === 0) {
            expect(await count(t, ctx, table, c.foreign(seed))).toBe(0);
            expect(await count(t, ctx, table, sql`true`)).toBeGreaterThan(0);
            if (c.own) expect(await count(t, ctx, table, c.own(seed))).toBeGreaterThan(0);
          } else {
            expect(pgCode(await failure(count(t, ctx, table, sql`true`)))).toBe('42501');
          }
        });

        if (c.update) {
          it(c.expect.update === 0 ? 'updates none of the other org’s rows' : 'cannot update the table', async () => {
            const { t, seed } = env();
            const run = withTenant(t.app.db, { ...actor.ctx(seed.b), requestId: 'isolation' }, (tx) => tx.execute(c.update!(seed)));
            if (c.expect.update === 0) expect((await run).rowCount).toBe(0);
            else expect(pgCode(await failure(run))).toBe('42501');
          });
        }

        it('cannot insert a row for the other org', async () => {
          const { t, seed } = env();
          const run = withTenant(t.app.db, { ...actor.ctx(seed.b), requestId: 'isolation' }, (tx) => tx.execute(c.insertForeign(seed)));
          expect(pgCode(await failure(run))).toBe('42501');
        });
      });
    }
  });
}
