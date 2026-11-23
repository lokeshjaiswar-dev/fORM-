import { sql } from 'drizzle-orm';
import type { Executor } from './client.ts';

/** How often a `unique_id` field starts again from `startAt` (schema `UniqueIdConfig.resetEvery`). */
export type SerialReset = 'never' | 'year' | 'month';

export interface NextSerialInput {
  orgId: string;
  formId: string;
  blockId: string;
  /** From `serialPeriod`. */
  period: string;
  /** The first number of a period; a counter already past it keeps counting. */
  startAt: number;
}

const FALLBACK_TIME_ZONE = 'UTC';

function zonedParts(at: Date, timeZone: string): { year: string; month: string } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' });
  } catch {
    // An unknown zone name is a stale or hand-edited definition; UTC keeps the counter usable.
    format = new Intl.DateTimeFormat('en-US', { timeZone: FALLBACK_TIME_ZONE, year: 'numeric', month: '2-digit' });
  }
  const parts = format.formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? String(at.getUTCFullYear());
  const month = parts.find((p) => p.type === 'month')?.value ?? String(at.getUTCMonth() + 1);
  return { year: year.padStart(4, '0'), month: month.padStart(2, '0') };
}

/** The counter row a submission at `at` draws from: '' never resets, 'YYYY' each year, 'YYYY-MM' each month. */
export function serialPeriod(reset: SerialReset, at: Date, timeZone: string): string {
  if (reset === 'never') return '';
  const { year, month } = zonedParts(at, timeZone);
  return reset === 'year' ? year : `${year}-${month}`;
}

/**
 * Issues the next serial for one field and period inside the caller's transaction. One upsert takes the row lock,
 * so concurrent submissions queue on it and never share a number; a rolled-back submission gives its number back.
 * Run inside `withTenant` (RLS scopes the row to the org).
 */
export async function nextSerial(tx: Executor, input: NextSerialInput): Promise<number> {
  const start = Number.isFinite(input.startAt) && input.startAt >= 0 ? Math.trunc(input.startAt) : 1;
  const { rows } = await tx.execute<{ value: string }>(sql`
    insert into form_serial_counters (org_id, form_id, block_id, period, last_value)
    values (${input.orgId}, ${input.formId}, ${input.blockId}, ${input.period}, ${start})
    on conflict (org_id, form_id, block_id, period) do update
      set last_value = greatest(form_serial_counters.last_value + 1, excluded.last_value), updated_at = now()
    returning last_value::text as value`);
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('nextSerial: the counter returned no row');
  return Number(value);
}
