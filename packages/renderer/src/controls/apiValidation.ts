import type { AnswerValue, Answers, FieldBlock, FieldError, PublicFormDefinition, SafeUrl } from '@form/schema';

export interface ApiCheckResult {
  ok: boolean;
  message?: string;
}

/** POSTs `{ [fieldKey]: value }` to the author's URL. The API should return `{ ok: boolean, message?: string }`. */
export async function postFieldApi(url: SafeUrl, fieldKey: string, value: unknown): Promise<ApiCheckResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldKey]: value }),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (data && typeof data === 'object' && 'ok' in data) {
      const body = data as { ok: unknown; message?: unknown };
      return {
        ok: body.ok === true,
        message: typeof body.message === 'string' && body.message.trim() ? body.message : undefined,
      };
    }
    return { ok: res.ok };
  } catch {
    return { ok: false, message: 'Could not reach the validation API.' };
  }
}

export function payloadValue(answer: AnswerValue | undefined): unknown {
  if (!answer) return undefined;
  const value = answer.value as unknown;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/** Visible fields with `apiValidation` that currently have an answer. */
export function apiValidationTargets(
  def: PublicFormDefinition,
  answers: Answers,
  visible: ReadonlySet<string>,
  pageId?: string,
): FieldBlock[] {
  const onPage = pageId ? new Set(def.pages.find((p) => p.id === pageId)?.children ?? []) : null;
  const out: FieldBlock[] = [];
  for (const block of Object.values(def.blocks)) {
    if (!('key' in block) || !block.apiValidation) continue;
    if (!visible.has(block.id)) continue;
    if (onPage && !onPage.has(block.id)) continue;
    if (payloadValue(answers[block.id]) === undefined) continue;
    out.push(block);
  }
  return out;
}

export async function verifyFieldApis(
  def: PublicFormDefinition,
  answers: Answers,
  visible: ReadonlySet<string>,
  pageId: string | undefined,
  fallback: string,
): Promise<FieldError[]> {
  const checks = apiValidationTargets(def, answers, visible, pageId).map(async (block): Promise<FieldError | null> => {
    const value = payloadValue(answers[block.id]);
    const url = block.apiValidation?.url;
    if (value === undefined || url === undefined) return null;
    const result = await postFieldApi(url, block.key, value);
    if (result.ok) return null;
    return { blockId: block.id, path: [], code: 'api_failed', message: result.message ?? fallback };
  });
  return (await Promise.all(checks)).filter((error): error is FieldError => error !== null);
}
