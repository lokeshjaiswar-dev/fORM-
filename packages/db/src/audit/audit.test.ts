import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../client.ts';
import { normaliseAuditEvent, type AuditEvent } from './append.ts';
import { archivableMonth, isArchivable, monthBounds } from './archive.ts';
import { checkpointMessage } from './checkpoint.ts';
import { auditIdChunks, auditReads, MAX_AUDITED_PAGE_IDS } from './reads.ts';
import { AUDIT_GENESIS, chainHash, recordFromPending, toHex } from './record.ts';
import { MAX_METADATA_BYTES, scrubAuditMetadata, storableText } from './scrub.ts';

const ORG = '0190f5a2-7c1e-7a00-8000-000000000001';
const USER = '0190f5a2-7c1e-7a00-8000-000000000002';
const AT = '2026-10-19T10:00:00.123456Z';

const event: AuditEvent = { actorKind: 'user', actorId: USER, action: 'submission.viewed', resourceType: 'submission', resourceId: 'abc', outcome: 'success' };

describe('scrubAuditMetadata', () => {
  it('drops answer containers at any depth and lists them', () => {
    expect(scrubAuditMetadata({ ids: ['a'], answers: { q1: 'x' }, nested: { Submission_Data: 'y', n: 1 } })).toEqual({
      ids: ['a'],
      nested: { n: 1 },
      _scrubbed: ['answers', 'nested.Submission_Data'],
    });
  });

  it('replaces long strings, deep nesting and oversized metadata instead of truncating them', () => {
    expect(scrubAuditMetadata({ note: 'x'.repeat(2000) })).toEqual({ note: '[omitted: 2000 chars]' });
    expect(scrubAuditMetadata({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[omitted: too deep]' } } }, _scrubbed: ['a.b.c.d'] });
    expect(scrubAuditMetadata({ list: Array.from({ length: 1001 }, (_, i) => i) }).list).toHaveLength(1001);
    expect(scrubAuditMetadata({ many: Array.from({ length: 900 }, () => 'y'.repeat(30)) })).toEqual({ _omitted: 'metadata over 16 KiB' });
  });

  it('keeps JSON-safe values only and the paths an earlier pass removed', () => {
    expect(scrubAuditMetadata({ n: Number.NaN, b: 10n, d: new Date(0), f: () => 1, u: undefined })).toEqual({ n: null, b: '10', d: '1970-01-01T00:00:00.000Z' });
    expect(scrubAuditMetadata({ _scrubbed: ['answers'], value: 1 })).toEqual({ _scrubbed: ['answers', 'value'] });
    expect(scrubAuditMetadata('nope')).toEqual({});
    expect(storableText(`a${String.fromCharCode(0)}b${String.fromCharCode(0xd800)}`)).toBe(`a${String.fromCharCode(0xfffd)}b${String.fromCharCode(0xfffd)}`);
  });
});

describe('normaliseAuditEvent', () => {
  it('accepts a catalogued action with an outcome it allows on the right path', () => {
    expect(normaliseAuditEvent({ ...event, reason: undefined, metadata: { answers: 1 } }, ['success'])).toEqual({
      actorKind: 'user',
      actorId: USER,
      action: 'submission.viewed',
      resourceType: 'submission',
      resourceId: 'abc',
      outcome: 'success',
      metadata: { _scrubbed: ['answers'] },
    });
  });

  it('refuses unknown actions, wrong outcomes, the wrong path and bad ids', () => {
    expect(() => normaliseAuditEvent({ ...event, action: 'nope' as AuditEvent['action'] }, ['success'])).toThrow(/unknown action/);
    expect(() => normaliseAuditEvent({ ...event, outcome: 'denied' }, ['denied'])).toThrow(/not recorded with outcome denied/);
    expect(() => normaliseAuditEvent({ ...event, action: 'request.authorize', outcome: 'denied' }, ['success'])).toThrow(/separate connection/);
    expect(() => normaliseAuditEvent(event, ['denied', 'error'])).toThrow(/business transaction/);
    expect(() => normaliseAuditEvent({ ...event, actorId: 'u1' }, ['success'])).toThrow(/actorId/);
    expect(() => normaliseAuditEvent({ ...event, actorIpHash: 'XYZ' }, ['success'])).toThrow(/actorIpHash/);
    expect(normaliseAuditEvent({ ...event, resourceId: 'r'.repeat(300) }, ['success']).resourceId).toHaveLength(256);
  });
});

describe('chain records', () => {
  it('hash sha256(prev ‖ JCS(record)), independent of key order', () => {
    const record = recordFromPending(ORG, 1, AT, { ...event, metadata: { b: 1, a: 2 } });
    const reordered = { ...record, metadata: { a: 2, b: 1 } };
    expect(toHex(chainHash(AUDIT_GENESIS, record))).toBe(toHex(chainHash(AUDIT_GENESIS, reordered)));
    expect(toHex(chainHash(AUDIT_GENESIS, record))).toMatch(/^[0-9a-f]{64}$/);
    expect(toHex(chainHash(new Uint8Array(32).fill(1), record))).not.toBe(toHex(chainHash(AUDIT_GENESIS, record)));
    expect(toHex(chainHash(AUDIT_GENESIS, { ...record, reason: 'x' }))).not.toBe(toHex(chainHash(AUDIT_GENESIS, record)));
  });

  it('fill absent fields with nulls and coerce malformed ones', () => {
    expect(recordFromPending(ORG, 7, AT, event)).toEqual({
      v: 1,
      orgKey: ORG,
      seq: 7,
      occurredAt: AT,
      actorKind: 'user',
      actorId: USER,
      impersonatorId: null,
      sessionId: null,
      apiKeyId: null,
      actorIpHash: null,
      actorUa: null,
      action: 'submission.viewed',
      resourceType: 'submission',
      resourceId: 'abc',
      formId: null,
      outcome: 'success',
      reason: null,
      metadata: {},
      requestId: null,
      traceId: null,
    });
    expect(recordFromPending(ORG, 1, AT, null).metadata).toEqual({ _malformed: ['actorKind', 'outcome', 'action', 'resourceType'] });
    expect(recordFromPending(ORG, 1, AT, { ...event, actorIpHash: 'zz', reason: 5 }).metadata).toEqual({ _malformed: ['actorIpHash', 'reason'] });
  });

  it('sign a canonical checkpoint statement', () => {
    const s = { orgKey: ORG, seq: 3, hash: new Uint8Array(32), signedAt: new Date('2026-10-19T10:00:00Z'), keyId: 'audit-v1', alg: 'ed25519' as const };
    expect(new TextDecoder().decode(checkpointMessage(s))).toBe(
      `{"alg":"ed25519","hash":"${'00'.repeat(32)}","keyId":"audit-v1","orgKey":"${ORG}","seq":3,"signedAt":"2026-10-19T10:00:00.000Z","type":"fr.audit.checkpoint","v":1}`,
    );
  });
});

describe('archive months', () => {
  it('keeps 13 full months online', () => {
    expect(archivableMonth(new Date('2026-10-19T00:00:00Z'))).toBe('2025-08');
    expect(archivableMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2024-11');
    expect(isArchivable('2025-08', new Date('2026-10-19T00:00:00Z'))).toBe(true);
    expect(isArchivable('2025-09', new Date('2026-10-19T00:00:00Z'))).toBe(false);
    expect(monthBounds('2024-12')).toEqual({ start: new Date('2024-12-01T00:00:00Z'), end: new Date('2025-01-01T00:00:00Z') });
    expect(() => monthBounds('2024-13')).toThrow(/YYYY-MM/);
  });
});

describe('audited reads over many ids (BL-192)', () => {
  const dialect = new PgDialect();
  const ctx = { orgId: ORG, actor: 'user' as const, userId: USER, requestId: 'req-1' };
  const FORM = '0190f5a2-7c1e-7a00-8000-0000000000f0';
  const uuids = (n: number) => Array.from({ length: n }, (_, i) => `0190f5a2-7c1e-7a00-8000-${String(i).padStart(12, '0')}`);

  /** A transaction that keeps the audit_pending events the reads write, as the scrubbed JSON the chain worker would read. */
  function recorder() {
    const events: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const tx = {
      execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
        events.push(JSON.parse(dialect.sqlToQuery(query).params[1] as string));
        return { rows: [] };
      },
    } as unknown as Tx;
    return { tx, events };
  }

  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  it('stores every id of a page of 500 across records, each within the metadata limit', async () => {
    const ids = uuids(MAX_AUDITED_PAGE_IDS);
    // Put in one record, as before the fix, they are over the limit and every id is dropped.
    expect(scrubAuditMetadata({ ids, count: ids.length })).toEqual({ _omitted: 'metadata over 16 KiB' });
    const { tx, events } = recorder();
    await auditReads.gridPage(tx, ctx, { formId: FORM, submissionIds: ids, page: 3, filtered: true });
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.action === 'submission.page_viewed')).toBe(true);
    expect(events.every((e) => !('_omitted' in e.metadata) && bytes(e.metadata) <= MAX_METADATA_BYTES)).toBe(true);
    expect(events.flatMap((e) => e.metadata.ids as string[])).toEqual(ids);
    expect(events.map((e) => [e.metadata.part, e.metadata.parts, e.metadata.count, e.metadata.page, e.metadata.filtered])).toEqual(
      events.map((_, i) => [i + 1, events.length, 500, 3, true]),
    );
  });

  it('leaves one record, with the keys it always had, for a page that fits one', async () => {
    const ids = uuids(2);
    const { tx, events } = recorder();
    await auditReads.gridPage(tx, ctx, { formId: FORM, submissionIds: ids, page: 1, filtered: false });
    expect(events.map((e) => e.metadata)).toEqual([{ ids, count: 2, page: 1, filtered: false }]);
    // A page with no rows is still a read.
    const empty = recorder();
    await auditReads.gridPage(empty.tx, ctx, { formId: FORM, submissionIds: [], page: 1, filtered: true });
    expect(empty.events.map((e) => e.metadata)).toEqual([{ ids: [], count: 0, page: 1, filtered: true }]);
  });

  it('splits API reads the same way and refuses more ids than it will record, instead of dropping the rest', async () => {
    const ids = uuids(MAX_AUDITED_PAGE_IDS);
    const { tx, events } = recorder();
    await auditReads.api(tx, ctx, { formId: FORM, submissionIds: ids });
    expect(events.flatMap((e) => e.metadata.ids as string[])).toEqual(ids);
    expect(events.every((e) => e.action === 'submission.api_read' && e.metadata.count === 500)).toBe(true);
    await expect(auditReads.api(tx, ctx, { formId: FORM, submissionIds: uuids(MAX_AUDITED_PAGE_IDS + 1) })).rejects.toThrow(RangeError);
    await expect(auditReads.gridPage(tx, ctx, { formId: FORM, submissionIds: uuids(MAX_AUDITED_PAGE_IDS + 1), page: 1, filtered: false })).rejects.toThrow(RangeError);
  });

  it('chunks by the real size of the ids, so long ids and short ones both fit', () => {
    const long = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(4, '0')}-${'x'.repeat(300)}`);
    for (const ids of [uuids(500), long, ['a', ...long, 'b'], []]) {
      const chunks = auditIdChunks(ids);
      expect(chunks.flat()).toEqual(ids);
      for (const chunk of chunks) expect(bytes({ ids: chunk, count: ids.length, page: 1, filtered: true, part: 9, parts: 9 })).toBeLessThanOrEqual(MAX_METADATA_BYTES);
    }
    expect(auditIdChunks([])).toEqual([[]]);
    expect(auditIdChunks(uuids(10))).toHaveLength(1);
  });
});
