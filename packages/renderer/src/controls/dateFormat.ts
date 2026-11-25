import type { DatePattern, IsoDate } from '@form/schema';

/* The pattern-aware date field's codec (controls/date.tsx): typed text in the block's pattern <-> ISO. */

export type Part = 'D' | 'M' | 'Y';
export interface DateFormat {
  order: readonly [Part, Part, Part];
  separator: string;
}

/** The numeric patterns as a part order and separator; the month-name patterns stay on the browser's own input. */
export const NUMERIC: Partial<Record<DatePattern, DateFormat>> = {
  'DD-MM-YYYY': { order: ['D', 'M', 'Y'], separator: '-' },
  'DD/MM/YYYY': { order: ['D', 'M', 'Y'], separator: '/' },
  'MM/DD/YYYY': { order: ['M', 'D', 'Y'], separator: '/' },
  'YYYY-MM-DD': { order: ['Y', 'M', 'D'], separator: '-' },
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const WIDTH: Readonly<Record<Part, number>> = { D: 2, M: 2, Y: 4 };

function real(y: number, m: number, d: number): IsoDate | undefined {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return undefined;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as IsoDate;
}

/** Typed text in the pattern's order (any of - / . or space between parts) to ISO; ISO itself is accepted too. */
export function parseDate(text: string, f: DateFormat): IsoDate | undefined {
  const s = text.trim();
  const iso = ISO.exec(s);
  if (iso) return real(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parts = s.split(/[-/. ]+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const at = (p: Part) => Number(parts[f.order.indexOf(p)]);
  if (parts[f.order.indexOf('Y')]!.length !== 4) return undefined;
  return real(at('Y'), at('M'), at('D'));
}

export function formatDate(value: IsoDate, f: DateFormat): string {
  const m = ISO.exec(value);
  if (!m) return value;
  const by: Record<Part, string> = { Y: m[1]!, M: m[2]!, D: m[3]! };
  return f.order.map((p) => by[p].padStart(WIDTH[p], '0')).join(f.separator);
}

