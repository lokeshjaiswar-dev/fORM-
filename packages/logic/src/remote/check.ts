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
