import { valueDefinition } from '@form/registry';
import type { Answers, FieldBlock, FormDefinition, ValueFieldType } from '@form/schema';
import { toPlain } from '@form/schema';
import { blockOrder, isField } from '@/lib/definition';
import type { SubmissionField } from '@/persistence/SubmissionsRepository';

function joinReadable(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(joinReadable).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.address === 'string' && rec.address) return rec.address;
    if (typeof rec.e164 === 'string' && rec.e164) return rec.e164;
    if ('optionId' in rec) return joinReadable(rec.other ?? rec.optionId);
    if (Array.isArray(rec.optionIds)) return rec.optionIds.map(joinReadable).concat(rec.other ? [joinReadable(rec.other)] : []).filter(Boolean).join(', ');
    if (typeof rec.name === 'string' && rec.name) return rec.name;
    if (typeof rec.fileId === 'string' && typeof rec.name === 'string') return rec.name;
    if (typeof rec.start === 'string' && typeof rec.end === 'string' && rec.start.includes('T')) {
      const zone = typeof rec.respondentTimeZone === 'string' ? rec.respondentTimeZone : 'UTC';
      const slots = Array.isArray(rec.slots) && rec.slots.length > 0 ? rec.slots : [{ start: rec.start, end: rec.end }];
      return slots
        .map((slot) => {
          if (!slot || typeof slot !== 'object') return '';
          const row = slot as { start?: unknown; end?: unknown };
          if (typeof row.start !== 'string' || typeof row.end !== 'string') return '';
          const from = new Date(row.start);
          const to = new Date(row.end);
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${row.start} – ${row.end}`;
          const date = new Intl.DateTimeFormat('en-IN', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(from);
          const start = new Intl.DateTimeFormat('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(from);
          const end = new Intl.DateTimeFormat('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(to);
          return `${date}, ${start} – ${end}`;
        })
        .filter(Boolean)
        .join('; ');
    }
    const pairs = Object.entries(rec)
      .filter(([key]) => key !== 'type' && key !== 'enc' && key !== 'file')
      .map(([key, v]) => {
        const right = joinReadable(v);
        return right ? `${key} - ${right}` : '';
      })
      .filter(Boolean);
    return pairs.join('\n');
  }
  return String(value);
}

function answerValue(answer: unknown): unknown {
  if (answer && typeof answer === 'object' && 'value' in answer) return (answer as { value: unknown }).value;
  return answer;
}

function registryText(block: FieldBlock, value: unknown): string | null {
  try {
    const def = valueDefinition(block.type as ValueFieldType);
    if (!def.export) return null;
    return (def.export.text as (v: unknown, b: unknown) => string)(value, block);
  } catch {
    return null;
  }
}

function fieldLabel(block: FieldBlock): string {
  return toPlain(block.label).trim() || block.key;
}

/** One readable line for a stored answer, using option labels and field text — never raw JSON. */
export function displayAnswer(block: FieldBlock | undefined, answer: unknown): string {
  const value = answerValue(answer);
  if (block && isField(block)) {
    const text = registryText(block, value);
    if (text != null && text.trim()) return text.trim();
  }
  return joinReadable(value);
}

/**
 * Labels and readable values for a filled form, in document order (including nested sections). The preview and the
 * published page keep these beside the answers of a response made in this browser; the Responses page does not use
 * them: it shows what the API built from the answers it validated (WP-1.15).
 */
export function answerRows(definition: Pick<FormDefinition, 'blocks' | 'pages'>, answers: Answers): SubmissionField[] {
  const rows: SubmissionField[] = [];
  for (const id of blockOrder(definition)) {
    const block = definition.blocks[id];
    if (!isField(block)) continue;
    const answer = answers[block.id];
    if (!answer) continue;
    rows.push({ key: block.key, label: fieldLabel(block), value: displayAnswer(block, answer) });
  }
  return rows;
}
