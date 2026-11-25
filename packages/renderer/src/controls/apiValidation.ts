import type { RawAnswers } from '@form/validation/lazy';
import { getAtPath, matchSuccessRule, parseApiBody } from '@form/logic';
import type { ApiCheckResult } from '@form/logic';
import type { AnswerValue, ApiRequestConfig, ApiValidation, FieldBlock, FieldError, PublicFormDefinition, SafeUrl } from '@form/schema';

/* The pure parsing and rule helpers live in @form/logic (shared with the API proxy); re-exported so author.ts keeps its exports. */
export { defaultSuccess, getAtPath, matchSuccessRule, parseApiBody } from '@form/logic';
export type { ApiCheckResult, ApiCollection, ApiLeafType, ApiParseResult, ApiResponseLeaf } from '@form/logic';

/**
 * The request the respondent's (or author's) browser sends. It never carries credentials: whatever the browser sends,
 * every respondent can read (Step 0 denylist, DEC-03), so `config.auth` on an old draft is ignored here, refused at
 * publish and stripped from the runtime projection.
 */
export function buildApiRequest(config: ApiRequestConfig, fieldKey?: string, value?: unknown): { url: string; init: RequestInit } {
  const method = config.method ?? 'POST';
  const parser = config.parser ?? 'json';
  const accept = parser === 'xml' ? 'application/xml, text/xml, application/json' : 'application/json';
  const url = new URL(config.url);
  for (const pair of config.query ?? []) {
    if (pair.key) url.searchParams.set(pair.key, pair.value);
  }
  const headers: Record<string, string> = { Accept: accept };
  if (method === 'GET') {
    if (fieldKey) url.searchParams.set(fieldKey, value == null ? '' : String(value));
    return { url: url.toString(), init: { method: 'GET', headers } };
  }
  const body: Record<string, unknown> = {};
  for (const pair of config.body ?? []) {
    if (pair.key) body[pair.key] = pair.value;
  }
  if (fieldKey) body[fieldKey] = value;
  headers['Content-Type'] = 'application/json';
  return { url: url.toString(), init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

export async function callFieldApi(config: ApiValidation, fieldKey: string, value: unknown): Promise<ApiCheckResult> {
  try {
    const { url, init } = buildApiRequest(config, fieldKey, value);
    const res = await fetch(url, init);
    const text = await res.text();
    const parser = config.parser ?? 'json';
    const parsed = text ? parseApiBody(text, parser) : { data: undefined, leaves: [], collections: [] };
    if (config.responseKey && config.success) {
      const leaf = getAtPath(parsed.data, config.responseKey);
      return { ok: matchSuccessRule(leaf, config.success) };
    }
    if (parsed.data && typeof parsed.data === 'object' && 'ok' in parsed.data) {
      const body = parsed.data as { ok: unknown; message?: unknown };
      const message = typeof body.message === 'string' && body.message.trim() ? body.message : '';
      return message ? { ok: body.ok === true, message } : { ok: body.ok === true };
    }
    return { ok: res.ok };
  } catch {
    return { ok: false, message: 'Could not reach the validation API.' };
  }
}

/** @deprecated use callFieldApi */
export async function postFieldApi(url: SafeUrl, fieldKey: string, value: unknown): Promise<ApiCheckResult> {
  return callFieldApi({ url }, fieldKey, value);
}

export function payloadValue(answer: AnswerValue | null | undefined): unknown {
  if (!answer) return undefined;
  const value = answer.value as unknown;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/** Visible fields with `apiValidation` that currently have an answer. */
export function apiValidationTargets(
  def: PublicFormDefinition,
  answers: RawAnswers,
  visible: ReadonlySet<string>,
  pageId?: string,
): FieldBlock[] {
  const onPage = pageId ? new Set(def.pages.find((p) => p.id === pageId)?.children ?? []) : null;
  const out: FieldBlock[] = [];
  for (const block of Object.values(def.blocks)) {
    if (!block || !('key' in block) || !block.apiValidation) continue;
    if (!visible.has(block.id)) continue;
    if (onPage && !onPage.has(block.id)) continue;
    if (payloadValue(answers[block.id]) === undefined) continue;
    out.push(block);
  }
  return out;
}

export async function verifyFieldApis(
  def: PublicFormDefinition,
  answers: RawAnswers,
  visible: ReadonlySet<string>,
  pageId: string | undefined,
  fallback: string,
): Promise<FieldError[]> {
  const checks = apiValidationTargets(def, answers, visible, pageId).map(async (block): Promise<FieldError | null> => {
    const value = payloadValue(answers[block.id]);
    const config = block.apiValidation;
    if (value === undefined || config === undefined) return null;
    const result = await callFieldApi(config, block.key, value);
    if (result.ok) return null;
    return { blockId: block.id, code: 'api_failed', message: result.message ?? fallback };
  });
  return (await Promise.all(checks)).filter((error): error is FieldError => error !== null);
}
