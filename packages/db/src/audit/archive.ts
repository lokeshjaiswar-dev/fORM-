import { sql } from 'drizzle-orm';
import type { Db, Executor } from '../client.ts';
import { asPlatformSystem } from './chain.ts';
import { readChainWhere } from './verify.ts';
import { toHex } from './record.ts';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Months stay online for 13 full months; the one before that window is the next to archive. */
export const AUDIT_ONLINE_MONTHS = 13;

export function isAuditMonth(v: unknown): v is string {
  return typeof v === 'string' && MONTH.test(v);
}

/** `[start, end)` of a `YYYY-MM` month in UTC. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const m = MONTH.exec(month);
  if (!m) throw new RangeError(`audit archive: month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}

/** The newest month outside the online window at `now`: the default of a monthly `audit.archive` run. */
export function archivableMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - AUDIT_ONLINE_MONTHS - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Whether `month` lies wholly before the online window at `now` (what `audit_archive_detach()` enforces). */
export function isArchivable(month: string, now: Date): boolean {
  return monthBounds(month).start <= monthBounds(archivableMonth(now)).start;
}

/**
 * The NDJSON lines of one month of the current tenant's chain, in seq order: each line is the hashed record plus
 * `prevHash` and `hash` (hex), so the archive verifies on its own.
 */
export async function* archiveLines(tx: Executor, month: string, pageSize = 2000): AsyncGenerator<{ line: string; seq: number }> {
  const { start, end } = monthBounds(month);
  let after = 0;
  for (;;) {
    const page = await readChainWhere(tx, sql`occurred_at >= ${start.toISOString()} and occurred_at < ${end.toISOString()} and seq > ${after}`, pageSize);
    for (const r of page) {
      yield { line: JSON.stringify({ ...r.record, prevHash: toHex(r.prevHash), hash: toHex(r.hash) }), seq: r.record.seq };
      after = r.record.seq;
    }
    if (page.length < pageSize) return;
  }
}

export interface ArchiveEntry {
  orgKey: string;
  month: string;
  objectKey: string;
  rowCount: number;
  minSeq: number;
  maxSeq: number;
  sha256: Uint8Array;
}

export async function recordArchive(tx: Executor, a: ArchiveEntry): Promise<void> {
  await tx.execute(sql`insert into audit_archives (org_key, month, object_key, row_count, min_seq, max_seq, sha256)
    values (${a.orgKey}, ${a.month}, ${a.objectKey}, ${a.rowCount}, ${a.minSeq}, ${a.maxSeq}, ${Buffer.from(a.sha256)})`);
}

export async function isMonthArchived(tx: Executor, month: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`select 1 from audit_archives where org_key = app_org() and month = ${month}`);
  return rows.length > 0;
}

/** Detaches the month's partition once every chain in it is archived (`audit_archive_detach()`); null when not attached. */
export async function detachArchivedMonth(db: Db, month: string): Promise<string | null> {
  const { rows } = await asPlatformSystem(db, 'audit.archive', (tx) => tx.execute<{ name: string | null }>(sql`select audit_archive_detach(${month}) as name`));
  return rows[0]?.name ?? null;
}
