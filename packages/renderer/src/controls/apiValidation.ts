import type { RawAnswers } from '@form/validation/lazy';
import type { AnswerValue, ApiRequestConfig, FieldBlock, FieldError, PublicFormDefinition } from '@form/schema';
import type { RemoteSource } from '../remote.ts';

/* The pure parsing and rule helpers live in @form/logic (shared with the API proxy); re-exported so author.ts keeps its exports. */
export { defaultSuccess, getAtPath, matchSuccessRule, parseApiBody } from '@form/logic';
export type { ApiCheckResult, ApiCollection, ApiLeafType, ApiParseResult, ApiResponseLeaf } from '@form/logic';

/**
 * The request the author's browser used to send for a Test button (the builder now goes through the author route and only
 * uses this to describe it). It sends nothing itself. It never carries credentials: whatever the browser sends,
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

/**
 * Runs the API checks of the visible fields on the page through the host's remote source (a public form never calls the
 * checked API itself). Without a source, or a source with no `check`, nothing is checked. A check that fails, or that could
 * not be run, blocks the page with the author's own message (`messages.api_failed`) or the system one.
 */
export async function verifyFieldApis(
  def: PublicFormDefinition,
  answers: RawAnswers,
  visible: ReadonlySet<string>,
  pageId: string | undefined,
  fallback: string,
  remote?: RemoteSource,
): Promise<FieldError[]> {
  const check = remote?.check;
  if (!check) return [];
  const signal = new AbortController().signal;
  const checks = apiValidationTargets(def, answers, visible, pageId).map(async (block): Promise<FieldError | null> => {
    const value = payloadValue(answers[block.id]);
    if (value === undefined) return null;
    const message = block.messages?.api_failed ?? fallback;
    try {
      if ((await check(block.id, value, signal)).ok) return null;
    } catch {
      /* The check could not be run: the page does not move on. */
    }
    return { blockId: block.id, code: 'api_failed', message };
  });
  return (await Promise.all(checks)).filter((error): error is FieldError => error !== null);
}
