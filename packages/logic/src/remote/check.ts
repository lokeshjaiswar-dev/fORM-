import type { ApiSuccessRule } from '@form/schema';
import { getAtPath, type ApiResponseLeaf } from './parse.ts';

export interface ApiCheckResult {
  ok: boolean;
  message?: string;
}

export function matchSuccessRule(value: unknown, rule: ApiSuccessRule): boolean {
  if (rule.type === 'boolean') {
    if (typeof value === 'boolean') return value === rule.equals;
    if (value === 'true' || value === 'false') return (value === 'true') === rule.equals;
    return false;
  }
  if (rule.type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    return Number.isFinite(n) && n === rule.equals;
  }
  const shown = value == null ? '' : String(value).trim();
  return rule.equals.some((allowed) => allowed.trim() === shown);
}

export function defaultSuccess(leaf: ApiResponseLeaf): ApiSuccessRule {
  if (leaf.type === 'boolean') return { type: 'boolean', equals: leaf.value === true };
  if (leaf.type === 'number') return { type: 'number', equals: typeof leaf.value === 'number' ? leaf.value : 1 };
  const text = String(leaf.value).trim() || 'ok';
  return { type: 'string', equals: [text] };
}


/**
 * Does the upstream's answer pass a field check? With `responseKey` and `success` the value at that path must match the rule;
 * otherwise a JSON object with an `ok` key passes when it is `true`, and any other 2xx answer (also an empty one) passes.
 * Pure: the API proxy decides it on the server and returns only `{ ok }`; the upstream body is never returned.
 */
export function evaluateCheck(data: unknown, config: { responseKey?: string | undefined; success?: ApiSuccessRule | undefined }): boolean {
  if (config.responseKey && config.success) return matchSuccessRule(getAtPath(data, config.responseKey), config.success);
  if (data && typeof data === 'object' && 'ok' in data) return (data as { ok: unknown }).ok === true;
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/**
 * The one scalar an API field check sends for an answer (the proxy's check body takes a string, number or boolean only): an
 * email's address, a phone's E.164, a choice's option id (or its "other" text), a date-time's instant, a time or date range
 * as an ISO interval (`start/end`), several choices as a JSON array of ids, and any other structured answer as JSON.
 * `undefined` when there is nothing to check. A value that already is a scalar is returned as it is.
 */
export function apiCheckValue(type: string, value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (!isObj(value)) return Array.isArray(value) ? (value.length === 0 ? undefined : JSON.stringify(value)) : undefined;
  switch (type) {
    case 'email':
      return text(value['address']);
    case 'phone':
      return text(value['e164']);
    case 'single_choice':
      return text(value['optionId']) ?? text(value['other']);
    case 'multi_choice': {
      const ids = Array.isArray(value['optionIds']) ? value['optionIds'].filter((id): id is string => typeof id === 'string') : [];
      const other = text(value['other']);
      const all = other === undefined ? ids : [...ids, other];
      return all.length === 0 ? undefined : JSON.stringify(all);
    }
    case 'datetime':
      return text(value['instant']) ?? text(value['local']);
    case 'time':
    case 'date_range': {
      const start = text(value['start']);
      const end = text(value['end']);
      return start === undefined ? undefined : end === undefined ? start : `${start}/${end}`;
    }
    default:
      return Object.keys(value).length === 0 ? undefined : JSON.stringify(value);
  }
}
