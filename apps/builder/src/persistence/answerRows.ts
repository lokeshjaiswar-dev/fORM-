import { valueDefinition } from '@form/registry';
import type { Answers, FieldBlock, FileRef, FormDefinition, StoredBlock, ValueFieldType } from '@form/schema';
import { toPlain } from '@form/schema';
import { blockOrder, isField } from '@/lib/definition';
import type { SubmissionField } from '@/persistence/SubmissionsRepository';

function isValueField(block: StoredBlock | undefined): block is FieldBlock {
  return isField(block);
}

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

function asFileRef(value: unknown): FileRef | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.fileId !== 'string' || typeof rec.name !== 'string') return null;
  return rec as unknown as FileRef;
}

export type AnswerMedia = { fileId?: string; assetId?: string; name: string; mime?: string };

/** A structured answer shown as a grid: first row is headers. */
export type AnswerTable = { headers: string[]; rows: string[][] };

export type ReadableField = SubmissionField & {
  media?: AnswerMedia[];
  /** Matrix and input-table answers, kept as rows and columns instead of flattened text. */
  table?: AnswerTable;
  /** Selected choice labels, shown as separate chips (dropdown, radio, checkbox). */
  choices?: string[];
};

type LabelLike = string | ReadonlyArray<string | { pipe: { fallback?: string } } | { var: { fallback?: string } }>;

function plainLabel(label: unknown): string {
  if (typeof label === 'string') return label;
  if (!Array.isArray(label)) return '';
  return (label as LabelLike & unknown[])
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'pipe' in part) return (part as { pipe: { fallback?: string } }).pipe.fallback ?? '';
      if (part && typeof part === 'object' && 'var' in part) return (part as { var: { fallback?: string } }).var.fallback ?? '';
      return '';
    })
    .join('');
}

function cellValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

/** Structured view for answers that read better as a grid or chips; undefined for everything else. */
function structuredFor(block: FieldBlock, answer: unknown): { table?: AnswerTable; choices?: string[] } | undefined {
  const value = answerValue(answer) as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') return undefined;

  if (block.type === 'matrix') {
    const config = block.config as unknown as {
      rows: Array<{ id: string; label: unknown }>;
      columns: Array<{ id: string; label: unknown }>;
    };
    const cells = (value.rows ?? {}) as Record<string, unknown>;
    const colLabel = (id: string) => plainLabel(config.columns.find((c) => c.id === id)?.label) || id;
    const headers = ['', ...config.columns.map((c) => plainLabel(c.label) || c.id)];
    const rows = config.rows.map((row) => {
      const cell = cells[row.id];
      const rowCells = config.columns.map((col) => {
        if (cell === undefined) return '';
        if (Array.isArray(cell)) return cell.map((id) => colLabel(String(id))).join(', ');
        if (cell && typeof cell === 'object') {
          const raw = (cell as Record<string, unknown>)[col.id];
          return cellValue(raw);
        }
        return cell === col.id ? '✓' : '';
      });
      return [plainLabel(row.label) || row.id, ...rowCells];
    });
    return { table: { headers, rows } };
  }

  if (block.type === 'dynamic_table') {
    const config = block.config as unknown as { columns: Array<{ id: string; label: unknown }> };
    const added = (value.addedColumns as Array<{ id: string; label: string }> | undefined) ?? [];
    const columns = [
      ...config.columns.map((c) => ({ id: c.id, label: plainLabel(c.label) || c.id })),
      ...added.map((c) => ({ id: c.id, label: c.label || c.id })),
    ];
    const rowsRaw = (value.rows as Array<{ cells?: Record<string, unknown> }> | undefined) ?? [];
    return {
      table: {
        headers: columns.map((c) => c.label),
        rows: rowsRaw.map((row) => columns.map((c) => cellValue(row.cells?.[c.id]))),
      },
    };
  }

  if (block.type === 'single_choice' || block.type === 'multi_choice') {
    const options = (block.config as unknown as { options: Array<{ id: string; label: unknown }> }).options;
    const labelOf = (id: string) => plainLabel(options.find((o) => o.id === id)?.label) || id;
    if (block.type === 'single_choice') {
      const optionId = value.optionId;
      const other = typeof value.other === 'string' ? value.other : '';
      const picked = typeof optionId === 'string' ? labelOf(optionId) : other;
      return picked ? { choices: [picked] } : undefined;
    }
    const ids = Array.isArray(value.optionIds) ? (value.optionIds as unknown[]).map(String) : [];
    const choices = ids.map(labelOf);
    if (typeof value.other === 'string' && value.other) choices.push(value.other);
    return choices.length ? { choices } : undefined;
  }

  return undefined;
}

function mediaFor(block: FieldBlock, answer: unknown): AnswerMedia[] {
  const value = answerValue(answer);
  if (block.type === 'file_upload' && Array.isArray(value)) {
    return value.flatMap((item) => {
      const file = asFileRef(item);
      return file ? [{ fileId: file.fileId, name: file.name, mime: file.mime }] : [];
    });
  }
  if (block.type === 'signature' && value && typeof value === 'object') {
    const file = asFileRef((value as { file?: unknown }).file);
    return file ? [{ fileId: file.fileId, name: file.name, mime: file.mime }] : [];
  }
  if ((block.type === 'single_choice' || block.type === 'multi_choice') && 'display' in block.config && block.config.display === 'image') {
    const options = block.config.options;
    const ids: string[] = [];
    if (block.type === 'single_choice' && value && typeof value === 'object') {
      const optionId = (value as { optionId?: unknown }).optionId;
      if (typeof optionId === 'string') ids.push(optionId);
    }
    if (block.type === 'multi_choice' && value && typeof value === 'object') {
      const optionIds = (value as { optionIds?: unknown }).optionIds;
      if (Array.isArray(optionIds)) ids.push(...optionIds.filter((id): id is string => typeof id === 'string'));
    }
    return ids.flatMap((id) => {
      const option = options.find((o) => o.id === id);
      const assetId = option?.image?.assetId;
      if (!assetId) return [];
      const name = typeof option.label === 'string' ? option.label : id;
      return [{ assetId, name }];
    });
  }
  return [];
}

/** One readable line for a stored answer, using option labels and field text — never raw JSON. */
export function displayAnswer(block: FieldBlock | undefined, answer: unknown): string {
  const value = answerValue(answer);
  if (block && isValueField(block)) {
    const text = registryText(block, value);
    if (text != null && text.trim()) return text.trim();
  }
  return joinReadable(value);
}

function looksLikeJson(value: string): string {
  return value.trim();
}

function isJson(value: string): boolean {
  const t = looksLikeJson(value);
  return t.startsWith('{') || t.startsWith('[');
}

/** Labels and readable values for a filled form, in document order (including nested sections). */
export function answerRows(definition: FormDefinition, answers: Answers): ReadableField[] {
  const rows: ReadableField[] = [];
  for (const id of blockOrder(definition)) {
    const block = definition.blocks[id];
    if (!isValueField(block)) continue;
    const answer = answers[block.id];
    if (!answer) continue;
    const media = mediaFor(block, answer);
    const structured = structuredFor(block, answer);
    rows.push({
      key: block.key,
      label: fieldLabel(block),
      value: displayAnswer(block, answer),
      ...(media.length ? { media } : {}),
      ...(structured?.table ? { table: structured.table } : {}),
      ...(structured?.choices ? { choices: structured.choices } : {}),
    });
  }
  return rows;
}

function decodeStoredValue(value: string): string {
  if (!isJson(value)) return value;
  try {
    return joinReadable(JSON.parse(value) as unknown) || value;
  } catch {
    return value;
  }
}

/** Rebuild from the form when it is available so labels and media stay current. */
export function readableFields(definition: FormDefinition | null, record: { answers: Record<string, unknown>; fields: SubmissionField[] }): ReadableField[] {
  if (definition) {
    const rebuilt = answerRows(definition, record.answers as Answers);
    if (rebuilt.length) return rebuilt;
  }
  return record.fields
    .filter((field) => field.label || field.value)
    .map((field) => ({
      key: field.key,
      label: field.label,
      value: decodeStoredValue(field.value),
      ...(field.table ? { table: field.table } : {}),
      ...(field.choices ? { choices: field.choices } : {}),
    }));
}
