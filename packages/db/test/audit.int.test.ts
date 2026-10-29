import { generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveLines,
  audit,
  auditChainKeys,
  auditHead,
  auditPendingKeys,
  auditReads,
  chainPending,
  checkpointMessage,
  detachArchivedMonth,
  PLATFORM_ORG_KEY,
  recordArchive,
  recordCheckpoint,
  resolveJobOrg,
  verifyChain,
  withTenant,
  type StoredCheckpoint,
  type TenantCtx,
} from '../src/index.ts';
import { failure, pgCode, setupTestDb, type TestDb } from './harness.ts';

let t: TestDb;
let signer: { privateKey: KeyObject; publicKey: KeyObject };

beforeAll(async () => {
  t = await setupTestDb();
  signer = generateKeyPairSync('ed25519');
});
afterAll(() => t?.close());

async function newOrg(): Promise<string> {
  const id = randomUUID();
  await t.owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [id, `org-${id.slice(0, 8)}`]);
  return id;
}

const system = (orgId: string): TenantCtx => ({ orgId, actor: 'system', requestId: 'audit-test' });
const user = (orgId: string): TenantCtx => ({ orgId, actor: 'user', userId: randomUUID(), requestId: 'req-1', perms: ['submissions.read'] });

const heartbeat = (orgId: string, metadata?: Record<string, unknown>) => ({
  actorKind: 'system' as const,
  action: 'system.heartbeat' as const,
  resourceType: 'org',
  resourceId: orgId,
  outcome: 'success' as const,
  ...(metadata ? { metadata } : {}),
});

async function append(orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await withTenant(t.app.db, system(orgId), (tx) => audit.append(tx, orgId, heartbeat(orgId, { i })));
}

const chain = (orgId: string, o: Parameters<typeof chainPending>[2] = {}) => withTenant(t.app.db, system(orgId), (tx) => chainPending(tx, orgId, o));

const verifySignature = async (cp: StoredCheckpoint) => verify(null, checkpointMessage(cp), signer.publicKey, cp.signature);
const snapshot = (orgId: string): TenantCtx => ({ ...system(orgId), readOnly: true, isolation: 'repeatable read' });
const verifyOrg = (orgId: string) => withTenant(t.app.db, snapshot(orgId), (tx) => verifyChain(tx, orgId, { verifySignature, pageSize: 7 }));

async function pendingCount(orgKey: string): Promise<number> {
  const { rows } = await t.owner.query<{ n: number }>('select count(*)::int as n from audit_pending where org_key = $1', [orgKey]);
  return rows[0]!.n;
}

async function checkpoint(orgId: string, keyId = 'audit-test'): Promise<StoredCheckpoint> {
  return withTenant(t.app.db, system(orgId), async (tx) => {
    const head = (await auditHead(tx))!;
    const statement = { orgKey: orgId, seq: head.seq, hash: head.hash, signedAt: new Date(), keyId, alg: 'ed25519' as const };
    const cp = { ...statement, signature: new Uint8Array(sign(null, checkpointMessage(statement), signer.privateKey)) };
    await recordCheckpoint(tx, { ...cp, anchoredObject: null });
    return cp;
  });
}

/** Runs DDL/DML as the owner with the append-only triggers off: what an attacker with the owner role could do. */
async function tamper(statement: string, params: unknown[]): Promise<void> {
  const c = await t.owner.connect();
  try {
    await c.query('begin');
    await c.query('alter table audit_log disable trigger user');
    await c.query(statement, params);
    await c.query('alter table audit_log enable trigger user');
    await c.query('commit');
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    c.release();
  }
}

describe('audit.chain', () => {
  it('moves pending rows into a hash chain the verifier accepts, and advances the head', async () => {
    const org = await newOrg();
    await append(org, 12);
    expect(await auditPendingKeys(t.app.db)).toEqual(expect.arrayContaining([{ orgKey: org, oldest: expect.any(Date), pending: 12 }]));
    const first = await chain(org, { batchSize: 5 });
    expect(first).toMatchObject({ acquired: true, chained: 12, head: { seq: 12 } });
    expect(first.maxLagMs).toBeGreaterThanOrEqual(0);
    expect(await pendingCount(org)).toBe(0);
    const { rows } = await t.owner.query<{ seq: string; metadata: { i: number } }>('select seq, metadata from audit_log where org_id = $1 order by seq', [org]);
    expect(rows.map((r) => [Number(r.seq), r.metadata.i])).toEqual(Array.from({ length: 12 }, (_, i) => [i + 1, i]));
    expect(await chain(org)).toMatchObject({ acquired: true, chained: 0, head: { seq: 12 } });
    await append(org, 3);
    expect(await chain(org, { maxRows: 2 })).toMatchObject({ chained: 2, head: { seq: 14 } });
    expect(await chain(org)).toMatchObject({ chained: 1, head: { seq: 15 } });
    await checkpoint(org);
    expect(await verifyOrg(org)).toMatchObject({ ok: true, headSeq: 15, rowsChecked: 15, checkpointsChecked: 1, latestCheckpointSeq: 15, problems: [] });
    expect(await auditChainKeys(t.app.db)).toContain(org);
  });

  it('chains platform events under the zero key, readable only in that tenant', async () => {
    await audit.appendDetached(t.app.db, null, { actorKind: 'none', action: 'request.authorize', resourceType: 'route', resourceId: 'GET /x', outcome: 'denied', reason: 'not_a_member' });
    const result = await chain(PLATFORM_ORG_KEY);
    expect(result.chained).toBeGreaterThanOrEqual(1);
    const rows = await withTenant(t.app.db, { ...system(PLATFORM_ORG_KEY), readOnly: true }, (tx) =>
      tx.execute<{ org_id: string; action: string }>(sql`select org_id, action from audit_log order by seq desc limit 1`),
    );
    expect(rows.rows).toEqual([{ org_id: PLATFORM_ORG_KEY, action: 'request.authorize' }]);
    expect((await verifyOrg(PLATFORM_ORG_KEY)).ok).toBe(true);
  });

  it('never holds the head in a business transaction: audited actions in one org do not serialise (F-21)', async () => {
    const org = await newOrg();
    await append(org, 1);
    await chain(org);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let businessPid = 0;
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => (opened = r));
    const slow = withTenant(t.app.db, user(org), async (tx) => {
      await audit.append(tx, org, { ...heartbeat(org), actorKind: 'user' });
      businessPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      opened();
      await gate;
    });
    await isOpen;
    try {
      const { rows } = await t.owner.query<{ n: number }>(
        `select count(*)::int as n from pg_locks l where l.pid = $1 and l.relation = 'public.audit_heads'::regclass`,
        [businessPid],
      );
      expect(rows[0]!.n).toBe(0);
      await append(org, 1);
      expect(await chain(org)).toMatchObject({ acquired: true, chained: 1, head: { seq: 2 } });
    } finally {
      release();
    }
    await slow;
    expect(await chain(org)).toMatchObject({ chained: 1, head: { seq: 3 } });
    expect((await verifyOrg(org)).ok).toBe(true);
  });

  it('lets one chainer per org work at a time; the other returns at once', async () => {
    const org = await newOrg();
    // The head exists from here on; only the very first pass of a chain makes a concurrent one wait for it.
    expect(await chain(org)).toMatchObject({ acquired: true, chained: 0, head: { seq: 0 } });
    await append(org, 2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const first = withTenant(t.app.db, system(org), async (tx) => {
      const r = await chainPending(tx, org);
      held();
      await gate;
      return r;
    });
    await isHeld;
    try {
      expect(await chain(org)).toEqual({ acquired: false, chained: 0, head: null, maxLagMs: 0 });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ acquired: true, chained: 2 });
  });

  it('refuses the chain functions to anyone but a system actor inside the tenant', async () => {
    const org = await newOrg();
    for (const run of [
      () => withTenant(t.app.db, user(org), (tx) => chainPending(tx, org)),
      () => t.app.db.transaction((tx) => chainPending(tx, org)),
      () => withTenant(t.app.db, user(org), (tx) => tx.execute(sql`select * from audit_pending_take(10)`)),
      () => withTenant(t.app.db, user(org), (tx) => tx.execute(sql`select audit_log_append('[]'::jsonb)`)),
    ]) {
      expect(pgCode(await failure(run()))).toBe('42501');
    }
    const outOfOrder = withTenant(t.app.db, system(org), (tx) => tx.execute(sql`select * from audit_pending_take(10)`));
    expect(pgCode(await failure(outOfOrder))).toBe('55000');
  });

  it('leaves checkpoints, archives and the cross-chain functions to system actors', async () => {
    const org = await newOrg();
    await append(org, 1);
    await chain(org);
    const { rows } = await t.owner.query<{ hash: Buffer }>('select hash from audit_heads where org_key = $1', [org]);
    const insertCheckpoint = sql`insert into audit_checkpoints (org_key, seq, hash, signed_at, key_id, alg, signature)
      values (${org}, 1, ${rows[0]!.hash}, now(), 'stray', 'ed25519', ${Buffer.alloc(64)})`;
    const insertArchive = sql`insert into audit_archives (org_key, month, object_key, row_count, min_seq, max_seq, sha256)
      values (${org}, '2020-03', 'stray', 1, 1, 1, ${Buffer.alloc(32)})`;
    const actors: TenantCtx[] = [
      user(org),
      { orgId: org, actor: 'api_key', requestId: 'r', perms: [] },
      { orgId: org, actor: 'respondent', requestId: 'r', subjectIds: [randomUUID()] },
    ];
    for (const ctx of actors) {
      for (const q of [insertCheckpoint, insertArchive]) expect(pgCode(await failure(withTenant(t.app.db, ctx, (tx) => tx.execute(q)))), ctx.actor).toBe('42501');
    }
    const crossChain = [sql`select * from audit_pending_keys()`, sql`select * from audit_chain_keys()`, sql`select audit_archive_detach('2000-01')`];
    for (const ctx of [user(PLATFORM_ORG_KEY), system(org)]) {
      for (const q of crossChain) expect(pgCode(await failure(withTenant(t.app.db, ctx, (tx) => tx.execute(q))))).toBe('42501');
    }
    for (const q of crossChain) expect(pgCode(await failure(t.app.db.execute(q)))).toBe('42501');
  });

  it('rejects rows that do not continue the head, for every role', async () => {
    const org = await newOrg();
    await append(org, 1);
    await chain(org);
    const insert = (seq: number, prev: Buffer) =>
      t.owner.query(
        `insert into audit_log (org_id, seq, occurred_at, actor_kind, action, resource_type, outcome, prev_hash, hash)
         values ($1, $2, now(), 'system', 'x', 'x', 'success', $3, $4)`,
        [org, seq, prev, Buffer.alloc(32, 1)],
      );
    const { rows } = await t.owner.query<{ hash: Buffer }>('select hash from audit_heads where org_key = $1', [org]);
    expect(pgCode(await failure(insert(3, rows[0]!.hash)))).toBe('23000');
    expect(pgCode(await failure(insert(2, Buffer.alloc(32))))).toBe('23000');
    expect(pgCode(await failure(insert(1, Buffer.alloc(32))))).toBe('23000');
    const err = await failure(
      withTenant(t.app.db, system(org), (tx) =>
        tx.execute(sql`insert into audit_log (org_id, seq, occurred_at, actor_kind, action, resource_type, outcome, prev_hash, hash)
                       values (${org}, 2, now(), 'system', 'x', 'x', 'success', ${rows[0]!.hash}, ${Buffer.alloc(32)})`),
      ),
    );
    expect(pgCode(err)).toBe('42501');
  });

  it('scrubs answer values from metadata and coerces malformed pending rows instead of wedging the chain', async () => {
    const org = await newOrg();
    await withTenant(t.app.db, system(org), (tx) =>
      audit.append(tx, org, heartbeat(org, { answers: { email: 'x@y.in' }, nested: { submissionData: 'secret', count: 2 } })),
    );
    await t.owner.query(`insert into audit_pending (org_key, event) values ($1, $2)`, [org, { action: 42, actorId: 'not-a-uuid', outcome: 'maybe' }]);
    expect(await chain(org)).toMatchObject({ chained: 2 });
    const { rows } = await t.owner.query<{ action: string; outcome: string; metadata: Record<string, unknown> }>(
      'select action, outcome, metadata from audit_log where org_id = $1 order by seq',
      [org],
    );
    expect(rows[0]).toEqual({ action: 'system.heartbeat', outcome: 'success', metadata: { nested: { count: 2 }, _scrubbed: ['answers', 'nested.submissionData'] } });
    expect(rows[1]).toEqual({ action: 'unknown', outcome: 'error', metadata: { _malformed: ['actorKind', 'outcome', 'actorId', 'action', 'resourceType'] } });
    expect((await verifyOrg(org)).ok).toBe(true);
  });

  it('resolves an audit_chain job resource to its own key while the chain exists', async () => {
    const org = await newOrg();
    expect(await resolveJobOrg(t.app.db, 'audit_chain', org)).toBeNull();
    await append(org, 1);
    expect(await resolveJobOrg(t.app.db, 'audit_chain', org)).toBe(org);
    await chain(org);
    expect(await resolveJobOrg(t.app.db, 'audit_chain', org)).toBe(org);
  });
});

describe('audit.verify detects tampering', () => {
  async function chainedOrg(n: number): Promise<string> {
    const org = await newOrg();
    await append(org, n);
    await chain(org);
    return org;
  }

  it('an edited row', async () => {
    const org = await chainedOrg(5);
    await tamper(`update audit_log set reason = 'edited' where org_id = $1 and seq = 3`, [org]);
    expect(await verifyOrg(org)).toMatchObject({ ok: false, problems: [{ code: 'hash_mismatch', seq: 3 }] });
  });

  it('a replaced hash, which also breaks the next link', async () => {
    const org = await chainedOrg(5);
    await tamper(`update audit_log set hash = $2 where org_id = $1 and seq = 3`, [org, Buffer.alloc(32, 7)]);
    const report = await verifyOrg(org);
    expect(report.problems.map((p) => p.code)).toEqual(['hash_mismatch', 'link_broken']);
  });

  it('a deleted row', async () => {
    const org = await chainedOrg(5);
    await tamper(`delete from audit_log where org_id = $1 and seq = 2`, [org]);
    expect((await verifyOrg(org)).problems).toEqual([{ code: 'rows_missing', seq: 2 }, { code: 'count_mismatch' }]);
  });

  it('a truncated tail', async () => {
    const org = await chainedOrg(4);
    await tamper(`delete from audit_log where org_id = $1 and seq = 4`, [org]);
    expect((await verifyOrg(org)).problems).toEqual([{ code: 'rows_missing', seq: 4 }, { code: 'count_mismatch' }]);
  });

  it('nothing on an untampered chain that a chainer extends between two pages', async () => {
    const org = await newOrg();
    await append(org, 4);
    await chain(org);
    await checkpoint(org);
    let extended = false;
    const report = await withTenant(t.app.db, snapshot(org), (tx) =>
      verifyChain(tx, org, {
        verifySignature,
        pageSize: 1,
        afterPage: async () => {
          if (extended) return;
          extended = true;
          await append(org, 3);
          expect((await chain(org)).head?.seq).toBe(7);
          await checkpoint(org);
        },
      }),
    );
    expect(extended).toBe(true);
    expect(report).toMatchObject({ ok: true, headSeq: 4, rowsChecked: 4, checkpointsChecked: 1, problems: [] });
    expect(await verifyOrg(org)).toMatchObject({ ok: true, headSeq: 7, rowsChecked: 7, checkpointsChecked: 2 });
  });

  it('refuses to walk a chain outside one snapshot', async () => {
    const org = await newOrg();
    await append(org, 1);
    await chain(org);
    const err = await failure(withTenant(t.app.db, { ...system(org), readOnly: true }, (tx) => verifyChain(tx, org, { verifySignature })));
    expect(String(err)).toMatch(/repeatable read/);
  });

  it('a forged checkpoint signature, and a checkpoint that names no link', async () => {
    const org = await chainedOrg(3);
    await checkpoint(org);
    await t.owner.query('alter table audit_checkpoints disable trigger user');
    try {
      await t.owner.query('update audit_checkpoints set signature = $2 where org_key = $1', [org, Buffer.alloc(64)]);
    } finally {
      await t.owner.query('alter table audit_checkpoints enable trigger user');
    }
    expect((await verifyOrg(org)).problems).toEqual([{ code: 'checkpoint_signature', seq: 3 }]);
    const fake = withTenant(t.app.db, system(org), (tx) =>
      recordCheckpoint(tx, { orgKey: org, seq: 2, hash: new Uint8Array(32), signedAt: new Date(), keyId: 'k', alg: 'ed25519', signature: new Uint8Array(64), anchoredObject: null }),
    );
    expect(pgCode(await failure(fake))).toBe('23000');
  });
});

describe('audit.archive', () => {
  const month = '2024-01';
  const partition = 'audit_log_2024_01';

  beforeAll(async () => {
    for (const [name, from, to] of [
      [partition, '2024-01-01', '2024-02-01'],
      ['audit_log_2024_02', '2024-02-01', '2024-03-01'],
      ['audit_log_2024_03', '2024-03-01', '2024-04-01'],
    ]) {
      await t.owner.query(`create table parts.${name} partition of audit_log for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00');
        alter table parts.${name} enable row level security, force row level security; revoke all on parts.${name} from public`);
    }
  });

  async function orgWithMonth(at: string): Promise<string> {
    const key = await newOrg();
    await t.owner.query(
      `insert into audit_pending (org_key, event, occurred_at) select $1, $2, $3::timestamptz + make_interval(secs => i) from generate_series(1, 3) i`,
      [key, heartbeat(key), at],
    );
    await append(key, 2);
    await chain(key);
    return key;
  }

  /** Holds a lock on audit_log the way a long audit.verify does, so a detach cannot get its exclusive lock. */
  async function holdingAuditLog<T>(fn: () => Promise<T>): Promise<T> {
    const c = await t.owner.connect();
    try {
      await c.query('begin');
      await c.query('select 1 from audit_log limit 1');
      return await fn();
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('exports a month per chain, detaches the partition only when every chain is archived, and verify accounts for it', async () => {
    const org = await orgWithMonth('2024-01-15 10:00:00+00');
    const other = await orgWithMonth('2024-01-15 10:00:00+00');
    const lines = await withTenant(t.app.db, { ...system(org), readOnly: true }, async (tx) => {
      const out: { line: string; seq: number }[] = [];
      for await (const l of archiveLines(tx, month, 2)) out.push(l);
      return out;
    });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ v: 1, orgKey: org, seq: 1, occurredAt: '2024-01-15T10:00:01.000000Z', prevHash: '00'.repeat(32) });

    const archive = (key: string) =>
      withTenant(t.app.db, system(key), (tx) =>
        recordArchive(tx, { orgKey: key, month, objectKey: `archive/${key}/${month}.ndjson.zst`, rowCount: 3, minSeq: 1, maxSeq: 3, sha256: new Uint8Array(32) }),
      );
    await archive(org);
    expect(pgCode(await failure(detachArchivedMonth(t.app.db, month)))).toBe('55000');
    // Archived but still attached: the month is walked online and is not counted twice.
    for (const key of [org, other]) expect(await verifyOrg(key)).toMatchObject({ ok: true, headSeq: 5, rowsChecked: 5, archivedRows: 0 });
    await archive(other);
    // A detach that cannot get its lock gives up instead of queueing every chainer behind it.
    expect(pgCode(await failure(holdingAuditLog(() => detachArchivedMonth(t.app.db, month))))).toBe('55P03');
    for (const key of [org, other]) expect(await verifyOrg(key)).toMatchObject({ ok: true, headSeq: 5, rowsChecked: 5, archivedRows: 0 });
    expect(await detachArchivedMonth(t.app.db, month)).toBe(`parts.${partition}`);
    expect(await detachArchivedMonth(t.app.db, month)).toBeNull();
    for (const key of [org, other]) expect(await verifyOrg(key)).toMatchObject({ ok: true, headSeq: 5, rowsChecked: 2, archivedRows: 3 });
    expect(pgCode(await failure(detachArchivedMonth(t.app.db, '2999-01')))).toBe('22023');
    expect(pgCode(await failure(detachArchivedMonth(t.app.db, 'May')))).toBe('22023');
  });

  it('sees a detach that commits after its snapshot but before it reads audit_log (BL-191)', async () => {
    const org = await orgWithMonth('2024-03-05 09:00:00+00');
    await withTenant(t.app.db, system(org), (tx) =>
      recordArchive(tx, { orgKey: org, month: '2024-03', objectKey: `archive/${org}/2024-03.ndjson.zst`, rowCount: 3, minSeq: 1, maxSeq: 3, sha256: new Uint8Array(32) }),
    );
    const report = await withTenant(t.app.db, snapshot(org), async (tx) => {
      // withTenant's first statement took the snapshot and holds no lock on audit_log, so the detach goes through.
      expect(await detachArchivedMonth(t.app.db, '2024-03')).toBe('parts.audit_log_2024_03');
      return verifyChain(tx, org, { verifySignature, pageSize: 7 });
    });
    expect(report).toMatchObject({ ok: true, problems: [], headSeq: 5, rowsChecked: 2, archivedRows: 3 });
  });

  it('reports rows deleted from an archived month that is still attached', async () => {
    const org = await orgWithMonth('2024-02-10 08:00:00+00');
    await withTenant(t.app.db, system(org), (tx) =>
      recordArchive(tx, { orgKey: org, month: '2024-02', objectKey: `archive/${org}/2024-02.ndjson.zst`, rowCount: 3, minSeq: 1, maxSeq: 3, sha256: new Uint8Array(32) }),
    );
    expect(await verifyOrg(org)).toMatchObject({ ok: true, rowsChecked: 5, archivedRows: 0 });
    await tamper(`delete from audit_log where org_id = $1 and seq = 2`, [org]);
    expect((await verifyOrg(org)).problems).toEqual([{ code: 'archive_mismatch', seq: 1 }, { code: 'rows_missing', seq: 2 }, { code: 'count_mismatch' }]);
  });
});

describe('audited reads', () => {
  it('record ids and counts in the read transaction, which must be read-write', async () => {
    const org = await newOrg();
    const ctx = user(org);
    const formId = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    await withTenant(t.app.db, ctx, async (tx) => {
      await auditReads.detail(tx, ctx, { formId, submissionId: ids[0]! });
      await auditReads.gridPage(tx, ctx, { formId, submissionIds: ids, page: 1, filtered: true });
      await auditReads.api(tx, ctx, { formId, submissionIds: ids });
      await auditReads.reveal(tx, ctx, { formId, submissionId: ids[0]!, fieldIds: ['pan'] });
      await auditReads.export(tx, ctx, { formId, exportId: randomUUID(), format: 'csv', includeSensitive: true, reason: 'DSR #12' });
      await auditReads.download(tx, ctx, { formId, fileId: randomUUID(), submissionId: ids[1]!, streamed: false });
    });
    expect(pgCode(await failure(withTenant(t.app.db, { ...ctx, readOnly: true }, (tx) => auditReads.detail(tx, ctx, { formId, submissionId: ids[0]! }))))).toBe('25006');
    await expect(
      withTenant(t.app.db, ctx, (tx) => auditReads.export(tx, ctx, { formId, exportId: randomUUID(), format: 'csv', includeSensitive: true })),
    ).rejects.toThrow(/reason/);
    await chain(org);
    const { rows } = await t.owner.query<{ action: string; actor_id: string; form_id: string; metadata: Record<string, unknown> }>(
      'select action, actor_id, form_id, metadata from audit_log where org_id = $1 order by seq',
      [org],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'submission.viewed',
      'submission.page_viewed',
      'submission.api_read',
      'submission.revealed',
      'submission.exported',
      'file.downloaded',
    ]);
    expect(rows.every((r) => r.actor_id === ctx.userId && r.form_id === formId)).toBe(true);
    expect(rows[1]!.metadata).toEqual({ ids, count: 2, page: 1, filtered: true });
  });
});
