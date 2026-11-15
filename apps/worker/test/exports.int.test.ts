import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createFilesystemStorage, type FilesystemStorage } from '@form/adapters/storage';
import { createDb, newSubmissionKey, provision, type DbHandle, type ExportScope } from '@form/db';
import { PortError, type PutOptions, type ReceivedJob, type Storage } from '@form/ports';
import type { FormDefinition } from '@form/schema';
import { createTestDatabase } from '@form/testkit';
import type { EffectDeps } from '../src/effects/deps.ts';
import { MASK } from '../src/effects/disclosure.ts';
import { compiledOf, definitionOf, field, personal, sensitive } from '../src/effects/export/test-forms.ts';
import { parseCsv } from '../src/effects/export/test-csv.ts';
import { createEffectJobs } from '../src/jobs/index.ts';
import { EXPORT_TTL_MS, exportBuild } from '../src/jobs/exports.ts';
import { runJob } from '../src/runtime.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.17: `export.build` end to end, against a real Postgres with RLS and the filesystem object store. A queued `exports` row
 * becomes a file in the `exports` bucket; what is in it follows the field settings (mask, omit, include_sensitive), the scope,
 * the version the response was filed under, and who asked (a reviewer of an `own_unit` form gets only their unit's columns).
 *
 * `EXPORT_PERF_ROWS=100000` runs the perf case at full size (budget 2 minutes); by default it is 10,000 rows in 12 seconds.
 */

const log = pino({ level: 'silent' });
const NOW = new Date('2026-11-16T10:00:00.000Z');
const PERF_ROWS = Number(process.env['EXPORT_PERF_ROWS'] ?? 10_000);
const PERF_BUDGET_MS = PERF_ROWS > 10_000 ? 120_000 : 12_000;

const DEVANAGARI = 'नमस्ते, मेरा नाम आशा है';
const TAMIL = 'வணக்கம், என் பெயர் ஆஷா';

let owner: pg.Pool;
let app: DbHandle;
let root: string;
let storage: FilesystemStorage;

interface Org {
  id: string;
  /** Owner of the org, in no review group. */
  ownerUser: string;
}

interface Form {
  id: string;
  version: string;
  definition: FormDefinition;
}

let a: Org;
let b: Org;

async function seedOrg(slug: string): Promise<Org> {
  const org: Org = { id: randomUUID(), ownerUser: randomUUID() };
  await owner.query('insert into orgs (id, slug, name) values ($1, $2, $2)', [org.id, slug]);
  await addUser(org, org.ownerUser, 'owner', `owner@${slug}.test`);
  return org;
}

async function addUser(org: Org, id: string, role: string, email: string): Promise<void> {
  await owner.query('insert into users (id, email, email_norm) values ($1, $2, $2)', [id, email]);
  await owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [org.id, id, role]);
}

/** A form with one published version holding `definition`. */
async function seedForm(org: Org, definition: FormDefinition, o: { number?: number; formId?: string } = {}): Promise<Form> {
  const formId = o.formId ?? randomUUID();
  const version = randomUUID();
  if (!o.formId) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5)', [formId, org.id, randomUUID(), org.ownerUser, 'Exports']);
  }
  await owner.query(
    `insert into form_versions (id, org_id, form_id, number, schema_version, published_by, definition, compiled, content_hash)
     values ($1, $2, $3, $4, 2, $5, $6, $7, $8)`,
    [version, org.id, formId, o.number ?? 1, org.ownerUser, JSON.stringify(definition), JSON.stringify(compiledOf(definition)), randomUUID().replaceAll('-', '').repeat(2)],
  );
  return { id: formId, version, definition };
}

type Answers = Record<string, { type: string; value: unknown }>;

/** A response stored the way the submit route does, `at` a moment inside the current month (which always has a partition). */
async function storeResponse(org: Org, form: Form, answers: Answers, o: { at?: Date; trashed?: boolean; status?: string } = {}): Promise<{ id: string; receivedAt: Date }> {
  const { id, receivedAt } = newSubmissionKey(o.at ?? new Date());
  await owner.query(
    `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta, trashed_at)
     values ($1, $2, $3, $4, $5, $6, 0, $7, $8, '{}', '{}', $9)`,
    [id, receivedAt, org.id, form.id, form.version, Buffer.alloc(32), o.status ?? 'complete', JSON.stringify(answers), o.trashed ? new Date() : null],
  );
  return { id, receivedAt };
}

async function queueExport(org: Org, form: Form, o: { format?: 'csv' | 'xlsx'; scope?: ExportScope | unknown; includeSensitive?: boolean; requestedBy?: string } = {}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into exports (id, org_id, form_id, requested_by, format, scope, include_sensitive, reason, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, org.id, form.id, o.requestedBy ?? org.ownerUser, o.format ?? 'csv', JSON.stringify(o.scope ?? { kind: 'all' }), o.includeSensitive ?? false, o.includeSensitive ? 'Audit request 42' : null, randomUUID()],
  );
  return id;
}

interface ExportState {
  status: string;
  row_count: string | null;
  object_key: string | null;
  bytes: string | null;
  error: string | null;
  finished_at: Date | null;
  expires_at: Date | null;
}

async function stateOf(id: string): Promise<ExportState> {
  const { rows } = await owner.query<ExportState>('select status, row_count, object_key, bytes, error, finished_at, expires_at from exports where id = $1', [id]);
  return rows[0]!;
}

function jobFor(org: Org, exportId: string, attempt = 1): ReceivedJob<'export.build'> {
  return {
    id: randomUUID(),
    name: 'export.build',
    attempt,
    envelope: { v: 1, orgId: org.id, resource: { type: 'export', id: exportId }, data: { exportId }, sig: 'unchecked-in-this-test' },
    signal: new AbortController().signal,
  };
}

const depsWith = (store: Storage | undefined): EffectDeps => ({ db: app.db, storage: store, now: () => NOW }) as unknown as EffectDeps;

/** Runs one attempt of the job as the worker runtime does (a tenant transaction per `inTenant`, actor `system`). */
async function run(org: Org, exportId: string, o: { attempt?: number; storage?: Storage | undefined } = {}): Promise<void> {
  const def = exportBuild(depsWith('storage' in o ? o.storage : storage));
  await runJob(def, jobFor(org, exportId, o.attempt), { db: app.db, log });
}

async function readObject(key: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await storage.get('exports', key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** A built CSV as rows of cells: BOM stripped, header first. */
async function csvOf(exportId: string): Promise<{ header: string[]; rows: string[][] }> {
  const state = await stateOf(exportId);
  expect(state.status, `export ${exportId}: ${state.error ?? ''}`).toBe('ready');
  const file = await readObject(state.object_key!);
  expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const [header, ...rows] = parseCsv(file.subarray(3).toString('utf8'));
  return { header: header!, rows };
}

const column = (table: { header: string[]; rows: string[][] }, header: string): string[] => {
  const at = table.header.indexOf(header);
  expect(at, `column ${header} in ${table.header.join(' | ')}`).toBeGreaterThanOrEqual(0);
  return table.rows.map((r) => r[at]!);
};

async function disclosuresOf(exportId: string): Promise<Array<{ submission_id: string; recipient_kind: string; display_name: string; field_keys: string[] }>> {
  const { rows } = await owner.query('select submission_id, recipient_kind, display_name, field_keys from disclosures where recipient_id = $1 order by submission_id', [exportId]);
  return rows;
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_worker_exports');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 4 });
  app = createDb(urls.fr_app, { max: 6, applicationName: 'fr-worker-exports-test' });
  root = await mkdtemp(path.join(tmpdir(), 'fr-exports-'));
  storage = createFilesystemStorage({ root, publicUrl: 'http://127.0.0.1/_dev/storage', signingKey: randomBytes(32) });
  a = await seedOrg('exports-a');
  b = await seedOrg('exports-b');
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('export.build: what is in the file', () => {
  const blocks = () => [personal('name'), sensitive('pan', 'mask'), sensitive('ssn', 'omit'), field({ id: 'age', type: 'number' })];
  const answersOf = (name: string): Answers => ({
    name: { type: 'short_text', value: name },
    pan: { type: 'short_text', value: 'ABCDE1234F' },
    ssn: { type: 'short_text', value: '123-45-6789' },
    age: { type: 'number', value: '31' },
  });
  let form: Form;
  let stored: Array<{ id: string; receivedAt: Date }>;

  beforeAll(async () => {
    form = await seedForm(a, definitionOf(blocks()));
    const base = new Date();
    stored = [];
    for (const [i, name] of [DEVANAGARI, TAMIL, 'Asha Kumar', '=cmd|\' /C calc\'!A0', 'Ravi'].entries()) {
      stored.push(await storeResponse(a, form, answersOf(name), { at: new Date(base.getTime() - 1000 * (10 - i)) }));
    }
  });

  it("shows a 'mask' field as MASK without include_sensitive and as its value with it; an 'omit' column is absent in both", async () => {
    const plain = await queueExport(a, form);
    await run(a, plain);
    const withSensitive = await queueExport(a, form, { includeSensitive: true });
    await run(a, withSensitive);

    const without = await csvOf(plain);
    expect(without.header).not.toContain('Label of ssn');
    expect(column(without, 'Label of pan')).toEqual(Array(5).fill(MASK));
    const withValue = await csvOf(withSensitive);
    expect(withValue.header).not.toContain('Label of ssn');
    expect(column(withValue, 'Label of pan')).toEqual(Array(5).fill('ABCDE1234F'));
    // The omitted answer is in neither file, in no column.
    for (const file of [without, withValue]) expect(file.rows.flat()).not.toContain('123-45-6789');
  });

  it('writes the response id and received-at, Devanagari and Tamil byte-exact, and escapes a formula payload', async () => {
    const id = await queueExport(a, form);
    await run(a, id);
    const table = await csvOf(id);
    expect(table.header.slice(0, 2)).toEqual(['Response ID', 'Received at']);
    expect(column(table, 'Response ID')).toEqual(stored.map((s) => s.id));
    expect(column(table, 'Received at')).toEqual(stored.map((s) => s.receivedAt.toISOString()));
    const names = column(table, 'Label of name');
    expect(Buffer.from(names[0]!, 'utf8').equals(Buffer.from(DEVANAGARI, 'utf8'))).toBe(true);
    expect(Buffer.from(names[1]!, 'utf8').equals(Buffer.from(TAMIL, 'utf8'))).toBe(true);
    expect(names[3]).toBe("'=cmd|' /C calc'!A0");
  });

  it("exports only the selected ids for scope 'selected', and nothing that is trashed or not a response of the form", async () => {
    const trashed = await storeResponse(a, form, answersOf('Trashed Tia'), { trashed: true });
    const other = await seedForm(a, definitionOf(blocks()));
    const elsewhere = await storeResponse(a, other, answersOf('Other form Omar'));
    const chosen = [stored[1]!, stored[3]!];
    const id = await queueExport(a, form, { scope: { kind: 'selected', ids: [...chosen.map((s) => s.id), trashed.id, elsewhere.id, randomUUID(), 'not-an-id'] } });
    await run(a, id);
    const table = await csvOf(id);
    expect(column(table, 'Response ID')).toEqual(chosen.map((s) => s.id));
    expect((await stateOf(id)).row_count).toBe('2');
  });

  it("honours the instants of scope 'filtered' (inclusive) and leaves out the trash for scope 'all'", async () => {
    const trashed = await storeResponse(a, form, answersOf('Trashed Tia'), { trashed: true });
    const window = await queueExport(a, form, { scope: { kind: 'filtered', from: stored[1]!.receivedAt.toISOString(), to: stored[3]!.receivedAt.toISOString() } });
    await run(a, window);
    expect(column(await csvOf(window), 'Response ID')).toEqual([stored[1]!.id, stored[2]!.id, stored[3]!.id]);

    const everything = await queueExport(a, form);
    await run(a, everything);
    const ids = column(await csvOf(everything), 'Response ID');
    expect(ids).toEqual(expect.arrayContaining(stored.map((s) => s.id)));
    expect(ids).not.toContain(trashed.id);
  });

  it('finishes the row as ready with row_count, bytes, object_key and a 24 h expiry, and the object is in the store', async () => {
    const id = await queueExport(a, form, { scope: { kind: 'selected', ids: stored.slice(0, 3).map((s) => s.id) } });
    await run(a, id);
    const state = await stateOf(id);
    expect(state).toMatchObject({ status: 'ready', row_count: '3', error: null, object_key: `${a.id}/${id}.csv` });
    expect(state.finished_at?.toISOString()).toBe(NOW.toISOString());
    expect(state.expires_at?.getTime()).toBe(NOW.getTime() + EXPORT_TTL_MS);
    const head = await storage.head('exports', state.object_key!);
    expect(head).not.toBeNull();
    expect(Number(state.bytes)).toBe(head!.bytes);
    expect(head!.contentType).toBe('text/csv; charset=utf-8');
  });

  it('writes one disclosures row per exported response, recipient kind export, naming the fields whose value is in the file', async () => {
    const ids = stored.slice(0, 4).map((s) => s.id);
    const plain = await queueExport(a, form, { scope: { kind: 'selected', ids } });
    await run(a, plain);
    const rows = await disclosuresOf(plain);
    expect(rows.map((r) => r.submission_id).sort()).toEqual([...ids].sort());
    for (const row of rows) {
      expect(row.recipient_kind).toBe('export');
      expect(row.display_name).toBe('CSV export');
      // pan is masked in this file (its value did not leave); ssn is omitted; name and age are in it.
      expect([...row.field_keys].sort()).toEqual(['age', 'name']);
    }
    const sensitiveRun = await queueExport(a, form, { scope: { kind: 'selected', ids: ids.slice(0, 1) }, includeSensitive: true });
    await run(a, sensitiveRun);
    expect([...(await disclosuresOf(sensitiveRun))[0]!.field_keys].sort()).toEqual(['age', 'name', 'pan']);
  });

  it('builds an XLSX the same way: strings only, the same texts, the formula payload escaped', async () => {
    const id = await queueExport(a, form, { format: 'xlsx', scope: { kind: 'selected', ids: stored.map((s) => s.id) } });
    await run(a, id);
    const state = await stateOf(id);
    expect(state).toMatchObject({ status: 'ready', row_count: '5', object_key: `${a.id}/${id}.xlsx` });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readObject(state.object_key!)) as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Responses')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    const at = (h: string) => header.indexOf(h) + 1;
    expect(sheet.getCell(2, at('Label of name')).value).toBe(DEVANAGARI);
    expect(sheet.getCell(3, at('Label of name')).value).toBe(TAMIL);
    expect(sheet.getCell(5, at('Label of name')).value).toBe("'=cmd|' /C calc'!A0");
    expect(sheet.getCell(2, at('Label of pan')).value).toBe(MASK);
    sheet.eachRow((row) => row.eachCell((cell) => expect(cell.formula, cell.address).toBeUndefined()));
    expect((await storage.head('exports', state.object_key!))!.contentType).toContain('spreadsheetml.sheet');
  });
});

describe('export.build: versions', () => {
  it('exports the union of the columns of every version, each response under its own version', async () => {
    const v1 = await seedForm(a, definitionOf([personal('name', {}, { label: 'Name (v1)' }), personal('old_only')]), { number: 1 });
    const v2 = await seedForm(a, definitionOf([personal('name', {}, { label: 'Full name' }), personal('new_only')]), { number: 2, formId: v1.id });
    await storeResponse(a, v1, { name: { type: 'short_text', value: 'Asha' }, old_only: { type: 'short_text', value: 'from v1' } }, { at: new Date(Date.now() - 2000) });
    await storeResponse(a, v2, { name: { type: 'short_text', value: 'Ravi' }, new_only: { type: 'short_text', value: 'from v2' } }, { at: new Date(Date.now() - 1000) });
    const id = await queueExport(a, v2);
    await run(a, id);
    const table = await csvOf(id);
    expect(table.header).toEqual(['Response ID', 'Received at', 'Full name', 'Label of new_only', 'Label of old_only']);
    expect(table.rows.map((r) => r.slice(2))).toEqual([
      ['Asha', '', 'from v1'],
      ['Ravi', 'from v2', ''],
    ]);
  });
});

describe('export.build: reviewers (own_unit redaction)', () => {
  let form: Form;
  let checkerA: string;
  let checkerB: string;
  let sibling: string;

  beforeAll(async () => {
    const blocks = [personal('a1'), personal('a2'), personal('b1'), personal('c1')];
    const definition = definitionOf(blocks, {
      pages: [
        { id: 'pa', children: ['a1', 'a2'] },
        { id: 'pb', children: ['b1'] },
        { id: 'pc', children: ['c1'] },
      ],
      review: [
        { id: 'u_a', name: 'Unit A', target: { kind: 'page', pageId: 'pa' } },
        { id: 'u_b', name: 'Unit B', target: { kind: 'page', pageId: 'pb' } },
      ] as never,
    });
    form = await seedForm(a, definition);
    checkerA = randomUUID();
    checkerB = randomUUID();
    sibling = randomUUID();
    await addUser(a, checkerA, 'editor', 'checker-a@exports-a.test');
    await addUser(a, checkerB, 'editor', 'checker-b@exports-a.test');
    await addUser(a, sibling, 'editor', 'sibling@exports-a.test');
    const groupA = randomUUID();
    const groupB = randomUUID();
    for (const [group, name, member] of [
      [groupA, 'Checkers A', checkerA],
      [groupB, 'Checkers B', checkerB],
    ] as const) {
      await owner.query('insert into review_groups (id, org_id, name, created_by) values ($1, $2, $3, $4)', [group, a.id, name, a.ownerUser]);
      await owner.query('insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)', [a.id, group, member, a.ownerUser]);
    }
    const settings = {
      distinctCheckers: false,
      units: [
        { unitId: 'u_a', groupId: groupA, order: 1, required: true, visibility: 'own_unit' },
        { unitId: 'u_b', groupId: groupB, order: 1, required: true, visibility: 'own_unit' },
      ],
    };
    await owner.query('insert into form_review_settings (form_id, org_id, enabled, settings) values ($1, $2, true, $3)', [form.id, a.id, JSON.stringify(settings)]);
    await storeResponse(a, form, {
      a1: { type: 'short_text', value: 'A-one' },
      a2: { type: 'short_text', value: 'A-two' },
      b1: { type: 'short_text', value: 'B-one' },
      c1: { type: 'short_text', value: 'C-one' },
    });
  });

  it('an export requested by a unit B checker has no unit A columns and none of their values', async () => {
    const id = await queueExport(a, form, { requestedBy: checkerB });
    await run(a, id);
    const table = await csvOf(id);
    expect(table.header).toEqual(['Response ID', 'Received at', 'Label of b1', 'Label of c1']);
    expect(table.rows.flat()).not.toContain('A-one');
    expect(table.rows.flat()).not.toContain('A-two');
    expect(table.rows[0]!.slice(2)).toEqual(['B-one', 'C-one']);
    // The ledger names only what the file holds.
    expect([...(await disclosuresOf(id))[0]!.field_keys].sort()).toEqual(['b1', 'c1']);
  });

  it('an export requested by the owner, who is in no review group, has all columns', async () => {
    for (const requestedBy of [a.ownerUser, sibling]) {
      const id = await queueExport(a, form, { requestedBy });
      await run(a, id);
      const table = await csvOf(id);
      expect(table.header).toEqual(['Response ID', 'Received at', 'Label of a1', 'Label of a2', 'Label of b1', 'Label of c1']);
      expect(table.rows[0]!.slice(2)).toEqual(['A-one', 'A-two', 'B-one', 'C-one']);
    }
  });

  it('keeps a unit B checker redacted after unit B was given to another group: their group still decides it on the responses in flight', async () => {
    const blocks = [personal('a1'), personal('b1')];
    const moved = await seedForm(
      a,
      definitionOf(blocks, {
        pages: [
          { id: 'pa', children: ['a1'] },
          { id: 'pb', children: ['b1'] },
        ],
        review: [
          { id: 'u_a', name: 'Unit A', target: { kind: 'page', pageId: 'pa' } },
          { id: 'u_b', name: 'Unit B', target: { kind: 'page', pageId: 'pb' } },
        ] as never,
      }),
    );
    const [oldB, newB, groupA] = [randomUUID(), randomUUID(), randomUUID()];
    const checker = randomUUID();
    await addUser(a, checker, 'editor', 'moved-checker@exports-a.test');
    for (const [group, name] of [
      [groupA, 'Moved A'],
      [oldB, 'Moved B (old)'],
      [newB, 'Moved B (new)'],
    ] as const) {
      await owner.query('insert into review_groups (id, org_id, name, created_by) values ($1, $2, $3, $4)', [group, a.id, name, a.ownerUser]);
    }
    await owner.query('insert into review_group_members (org_id, group_id, user_id, added_by) values ($1, $2, $3, $4)', [a.id, oldB, checker, a.ownerUser]);
    // The live settings now give unit B to the new group; the checker sits only in the old one.
    const settings = {
      distinctCheckers: false,
      units: [
        { unitId: 'u_a', groupId: groupA, order: 1, required: true, visibility: 'own_unit' },
        { unitId: 'u_b', groupId: newB, order: 1, required: true, visibility: 'own_unit' },
      ],
    };
    await owner.query('insert into form_review_settings (form_id, org_id, enabled, settings) values ($1, $2, true, $3)', [moved.id, a.id, JSON.stringify(settings)]);
    // A response opened for review before the move: its unit-B row still names the old group, and is pending.
    const held = await storeResponse(a, moved, { a1: { type: 'short_text', value: 'A-secret' }, b1: { type: 'short_text', value: 'B-mine' } }, { status: 'pending_review' });
    for (const [unitId, group] of [
      ['u_a', groupA],
      ['u_b', oldB],
    ] as const) {
      await owner.query(
        `insert into submission_reviews (org_id, form_id, submission_id, submission_received_at, unit_id, required, review_order, group_id, visibility, answers_hash)
         values ($1, $2, $3, $4, $5, true, 1, $6, 'own_unit', $7)`,
        [a.id, moved.id, held.id, held.receivedAt, unitId, group, Buffer.alloc(32)],
      );
    }

    const id = await queueExport(a, moved, { requestedBy: checker });
    await run(a, id);
    const table = await csvOf(id);
    expect(table.header).toEqual(['Response ID', 'Received at', 'Label of b1']);
    expect(table.rows.flat()).not.toContain('A-secret');
    expect(table.rows[0]!.slice(2)).toEqual(['B-mine']);
    expect([...(await disclosuresOf(id))[0]!.field_keys]).toEqual(['b1']);
  });

  it('fails the export, and shows nothing, when the review settings no longer parse', async () => {
    const broken = await seedForm(a, definitionOf([personal('x1')]));
    await owner.query('insert into form_review_settings (form_id, org_id, enabled, settings) values ($1, $2, true, $3)', [broken.id, a.id, JSON.stringify({ units: 'nonsense' })]);
    await storeResponse(a, broken, { x1: { type: 'short_text', value: 'secret' } });
    const id = await queueExport(a, broken, { requestedBy: checkerA });
    await run(a, id);
    expect(await stateOf(id)).toMatchObject({ status: 'failed', object_key: null, error: expect.stringContaining('review settings are not valid') });
    expect(await disclosuresOf(id)).toEqual([]);
  });
});

describe('export.build: attempts, failures and isolation', () => {
  const blocks = () => [personal('name')];
  let form: Form;

  beforeAll(async () => {
    form = await seedForm(a, definitionOf(blocks()));
    for (let i = 0; i < 4; i += 1) await storeResponse(a, form, { name: { type: 'short_text', value: `Person ${i}` } }, { at: new Date(Date.now() - 1000 * (i + 1)) });
  });

  it('a second delivery of a finished export builds nothing and leaves the file as it was', async () => {
    const id = await queueExport(a, form);
    await run(a, id);
    const first = await stateOf(id);
    await run(a, id);
    expect(await stateOf(id)).toEqual(first);
    expect(await disclosuresOf(id)).toHaveLength(4);
  });

  it('a retry after a failed upload writes one disclosures row per response, not two, and no half file stays', async () => {
    const failing: Storage = {
      ...storage,
      capabilities: () => storage.capabilities(),
      async put(_bucket: 'exports', _key: string, body: AsyncIterable<Uint8Array> | Uint8Array, _o: PutOptions) {
        if (!(body instanceof Uint8Array)) for await (const _chunk of body) void _chunk;
        throw new PortError('unavailable', 'the store is down');
      },
    } as unknown as Storage;
    const id = await queueExport(a, form);
    await expect(run(a, id, { storage: failing })).rejects.toThrow('the store is down');
    // Not the last attempt: the export is still running, being retried.
    expect(await stateOf(id)).toMatchObject({ status: 'running', object_key: null });
    expect(await storage.head('exports', `${a.id}/${id}.csv`)).toBeNull();

    await run(a, id, { attempt: 2 });
    expect(await stateOf(id)).toMatchObject({ status: 'ready', row_count: '4' });
    expect(await disclosuresOf(id)).toHaveLength(4);
  });

  it('marks the export failed on the last attempt with a scrubbed message that holds no answer, key or path', async () => {
    const down: Storage = {
      ...storage,
      capabilities: () => storage.capabilities(),
      async put() {
        throw new PortError('unavailable', `cannot write ${root} Person 0`);
      },
    } as unknown as Storage;
    const id = await queueExport(a, form);
    await expect(run(a, id, { storage: down, attempt: 3 })).rejects.toThrow();
    const state = await stateOf(id);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('The file could not be saved to storage. Try again in a few minutes.');
    expect(state.error).not.toContain('Person');
    expect(state.finished_at).not.toBeNull();
  });

  it('fails an XLSX whose upload fails the same way, without an unhandled error from the zip stream', async () => {
    const down: Storage = {
      ...storage,
      capabilities: () => storage.capabilities(),
      async put(_bucket: 'exports', _key: string, body: AsyncIterable<Uint8Array> | Uint8Array) {
        if (!(body instanceof Uint8Array)) for await (const chunk of body) void chunk;
        throw new PortError('unavailable', 'the store is down');
      },
    } as unknown as Storage;
    const id = await queueExport(a, form, { format: 'xlsx' });
    await expect(run(a, id, { storage: down, attempt: 3 })).rejects.toThrow('the store is down');
    expect(await stateOf(id)).toMatchObject({ status: 'failed', object_key: null });
  });

  it('is the handler of the export.build queue in the effect jobs, one transaction per unit of work', () => {
    const def = createEffectJobs(depsWith(storage)).find((d) => d.name === 'export.build');
    expect(def).toMatchObject({ name: 'export.build', transaction: 'manual', perms: [] });
  });

  it('fails an export for good, without a retry, when the scope is not one the API writes or no storage is configured', async () => {
    const badScope = await queueExport(a, form, { scope: { kind: 'selected', ids: 'all of them' } });
    await run(a, badScope);
    expect(await stateOf(badScope)).toMatchObject({ status: 'failed', error: 'The export asked for responses in a way that is not valid.' });

    const noStorage = await queueExport(a, form);
    await run(a, noStorage, { storage: undefined });
    expect(await stateOf(noStorage)).toMatchObject({ status: 'failed', error: 'Exports are not available here: no object storage is configured.' });
  });

  it("another org's export is not found from this org's job: it is left alone", async () => {
    const otherForm = await seedForm(b, definitionOf(blocks()));
    await storeResponse(b, otherForm, { name: { type: 'short_text', value: 'Bea' } });
    const theirs = await queueExport(b, otherForm);
    await run(a, theirs);
    expect(await stateOf(theirs)).toMatchObject({ status: 'queued', object_key: null });
    expect(await disclosuresOf(theirs)).toEqual([]);
  });
});

describe('export.build: perf', () => {
  it(`builds a CSV of ${PERF_ROWS} responses within ${PERF_BUDGET_MS / 1000} s`, { timeout: PERF_BUDGET_MS * 4 }, async () => {
    const form = await seedForm(a, definitionOf([personal('name'), personal('city'), field({ id: 'age', type: 'number' })]));
    // Ids carry their own moment, so seed with unnest: ten thousand inserts one by one would dwarf the export being measured.
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 1));
    const keys = Array.from({ length: PERF_ROWS }, (_, i) => newSubmissionKey(new Date(monthStart.getTime() + i * 100)));
    for (let from = 0; from < keys.length; from += 5000) {
      const part = keys.slice(from, from + 5000);
      await owner.query(
        `insert into submissions (id, received_at, org_id, form_id, form_version_id, definition_hash, answer_codec_version, status, answers, computed, meta)
         select k.id, k.received_at, $3::uuid, $4::uuid, $5::uuid, $6::bytea, 0, 'complete',
                jsonb_build_object('name', jsonb_build_object('type', 'short_text', 'value', 'Person ' || k.n),
                                   'city', jsonb_build_object('type', 'short_text', 'value', 'Chennai, ' || (k.n % 97)),
                                   'age', jsonb_build_object('type', 'number', 'value', (18 + k.n % 60)::text)),
                '{}', '{}'
         from unnest($1::uuid[], $2::timestamptz[]) with ordinality as k(id, received_at, n)`,
        [part.map((k) => k.id), part.map((k) => k.receivedAt), a.id, form.id, form.version, Buffer.alloc(32)],
      );
    }
    const id = await queueExport(a, form);
    const started = performance.now();
    await run(a, id);
    const ms = performance.now() - started;
    const state = await stateOf(id);
    expect(state).toMatchObject({ status: 'ready', row_count: String(PERF_ROWS) });
    expect(ms, `built ${PERF_ROWS} rows in ${Math.round(ms)} ms`).toBeLessThan(PERF_BUDGET_MS);
    const { rows } = await owner.query<{ n: string }>('select count(*) as n from disclosures where recipient_id = $1', [id]);
    expect(rows[0]!.n).toBe(String(PERF_ROWS));
    // The file is complete and in order: the first and last response by (received_at, id).
    const file = (await readObject(state.object_key!)).toString('utf8');
    const lines = file.trimEnd().split('\r\n');
    expect(lines).toHaveLength(PERF_ROWS + 1);
    expect(lines[1]!.startsWith(keys[0]!.id)).toBe(true);
    expect(lines.at(-1)!.startsWith(keys.at(-1)!.id)).toBe(true);
  });
});
