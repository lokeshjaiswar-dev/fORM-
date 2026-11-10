import type { Answers, FormDefinition } from '@form/schema';
import { toPlain } from '@form/schema';
import { isField } from '@/lib/definition';
import type { SubmissionField } from '@/persistence/SubmissionsRepository';

function displayValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.address === 'string') return rec.address;
    if (typeof rec.e164 === 'string') return rec.e164;
    if ('optionId' in rec) return String(rec.other ?? rec.optionId ?? '');
    if (Array.isArray(rec.optionIds)) return rec.optionIds.map(String).concat(rec.other ? [String(rec.other)] : []).join(', ');
    return JSON.stringify(value);
  }
  return String(value);
}

/** Labels and readable values for a filled form, in page order. */
export function answerRows(definition: FormDefinition, answers: Answers): SubmissionField[] {
  const rows: SubmissionField[] = [];
  for (const page of definition.pages) {
    for (const id of page.children) {
      const block = definition.blocks[id];
      if (!isField(block)) continue;
      const answer = answers[block.id];
      if (!answer) continue;
      rows.push({
        key: block.key,
        label: toPlain(block.label) || block.key,
        value: displayValue(answer.value),
      });
    }
  }
  return rows;
}
