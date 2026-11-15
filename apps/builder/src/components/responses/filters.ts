import { useEffect, useState } from 'react';
import type { GridQuery, View } from '@/persistence/submissionsApi';

export type ReadFilter = 'all' | 'unread' | 'read';
export type StatusFilter = 'all' | 'complete' | 'spam';

/** What the member typed or picked above the grid. Dates are the `YYYY-MM-DD` of a date input, in the member's own time zone. */
export interface ResponseFilters {
  q: string;
  from: string;
  to: string;
  read: ReadFilter;
  starred: boolean;
  status: StatusFilter;
}

export const NO_FILTERS: ResponseFilters = { q: '', from: '', to: '', read: 'all', starred: false, status: 'all' };

export const hasFilters = (f: ResponseFilters): boolean =>
  f.q.trim() !== '' || f.from !== '' || f.to !== '' || f.read !== 'all' || f.starred || f.status !== 'all';

/** The moment a day starts for the member (local time) as an ISO instant, or undefined for no day or one that is not a date. */
export function dayStart(day: string): string | undefined {
  if (!day) return undefined;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The last moment of a day for the member (local time) as an ISO instant. */
export function dayEnd(day: string): string | undefined {
  if (!day) return undefined;
  const at = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** A range that ends before it starts: the API refuses it, so the page does not ask. */
export function rangeIsBackwards(f: ResponseFilters): boolean {
  const from = dayStart(f.from);
  const to = dayEnd(f.to);
  return from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to);
}

/** The grid query for a folder and filters, or null when the dates cannot be asked for (see `rangeIsBackwards`). */
export function toGridQuery(view: View, f: ResponseFilters): GridQuery | null {
  if (rangeIsBackwards(f)) return null;
  const q = f.q.trim();
  const from = dayStart(f.from);
  const to = dayEnd(f.to);
  return {
    view,
    ...(q ? { q } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(f.read === 'all' ? {} : { read: f.read === 'read' }),
    ...(f.starred ? { starred: true } : {}),
    ...(f.status === 'all' ? {} : { status: f.status }),
  };
}

/** `value`, once it has stopped changing for `ms`: the search box asks the API after a pause, not on every key. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
