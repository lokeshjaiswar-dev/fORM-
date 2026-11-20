import { z } from 'zod';

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const INDEX = /^\d+$/;
const REPEATED = /^([A-Za-z_][A-Za-z0-9_-]*)\[\]$/;

export const submissionApiSchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2000),
  format: z.enum(['json', 'xml']),
  keys: z.array(z.object({
    path: z.string().max(200),
    fieldKey: z.string().max(64),
    /** `column:Item`, `summary:Total`, `name:first`, or empty for the whole field. */
    part: z.string().max(80).default(''),
    required: z.boolean(),
  })).max(100),
});

export type SubmissionApiConfig = z.infer<typeof submissionApiSchema>;

export interface DeliveryField {
  key: string;
  value: unknown;
}

function segments(path: string): string[] | null {
  const trimmed = path.trim();
  if (!trimmed) return [];
  const parts = trimmed.split('.');
  if (parts.some((part) => !SEGMENT.test(part) && !INDEX.test(part) && !REPEATED.test(part))) return null;
  return parts;
}

function assign(root: unknown, parts: string[], value: unknown): unknown {
  if (!parts.length) return value;
  const [head, ...rest] = parts;
  const repeated = REPEATED.exec(head!);
  if (repeated) {
    const obj = root && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
    const existing = Array.isArray(obj[repeated[1]!]) ? [...(obj[repeated[1]!] as unknown[])] : [];
    const rows = Array.isArray(value) ? value : [value];
    rows.forEach((row, index) => {
      existing[index] = assign(existing[index], rest, row);
    });
    obj[repeated[1]!] = existing;
    return obj;
  }
  if (INDEX.test(head!)) {
    const list = Array.isArray(root) ? [...root] : [];
    list[Number(head)] = assign(list[Number(head)], rest, value);
    return list;
  }
  const obj = root && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {};
  obj[head!] = assign(obj[head!], rest, value);
  return obj;
}

/** Pull one piece out of a structured field. Empty part keeps the whole value. */
export function projectPart(value: unknown, part: string): unknown {
  if (!part) return value;
  if (part.startsWith('column:') && value && typeof value === 'object' && 'rows' in value) {
    const name = part.slice('column:'.length);
    const rows = (value as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((row) => row[name] ?? '');
  }
  if (part.startsWith('summary:') && value && typeof value === 'object') {
    const name = part.slice('summary:'.length);
    return (value as { summary?: Record<string, unknown> }).summary?.[name] ?? '';
  }
  if (part.startsWith('name:') && value && typeof value === 'object') {
    return (value as Record<string, unknown>)[part.slice('name:'.length)] ?? '';
  }
  return value;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlNode(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    return value.map((item, i) => `${indent}<item index="${i}">\n${xmlNode(item, indent + '  ')}\n${indent}</item>`).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => {
        const inner = xmlNode(child, indent + '  ');
        if (typeof child !== 'object' || child === null) return `${indent}<${key}>${inner}</${key}>`;
        return `${indent}<${key}>\n${inner}\n${indent}</${key}>`;
      })
      .join('\n');
  }
  if (typeof value === 'string') return escapeXml(value);
  if (value === undefined || value === null) return '';
  return escapeXml(JSON.stringify(value));
}

/** https, or http only when the host is this machine (local testing). */
export function allowedDeliveryUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url;
  } catch {
    /* Not a URL. */
  }
  return null;
}

export function renderDelivery(config: SubmissionApiConfig, fields: DeliveryField[]): { body: string; contentType: string } | { error: string } {
  const values = new Map(fields.map((field) => [field.key, field.value]));
  const missing = config.keys.filter((key) => key.required && key.path.trim() && !key.fieldKey.trim());
  if (missing.length) return { error: `required paths are not mapped: ${missing.map((key) => key.path).join(', ')}` };
  let tree: unknown = {};
  for (const key of config.keys) {
    if (!key.fieldKey.trim()) continue;
    const parts = segments(key.path);
    if (parts === null) return { error: `invalid path: ${key.path}` };
    if (!parts.length) continue;
    tree = assign(tree, parts, projectPart(values.get(key.fieldKey) ?? '', key.part ?? ''));
  }
  if (config.format === 'xml') {
    return { body: `<submission>\n${xmlNode(tree, '  ')}\n</submission>`, contentType: 'application/xml' };
  }
  return { body: JSON.stringify(tree), contentType: 'application/json' };
}

/** POST the mapped answers. A failed call does not fail the respondent's submit. */
export async function deliverSubmission(config: SubmissionApiConfig | undefined, fields: DeliveryField[]): Promise<{ sent: boolean; status?: number; error?: string }> {
  if (!config?.enabled) return { sent: false };
  const url = allowedDeliveryUrl(config.url);
  if (!url) return { sent: false, error: 'destination URL must be https, or http on localhost' };
  const rendered = renderDelivery(config, fields);
  if ('error' in rendered) return { sent: false, error: rendered.error };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': rendered.contentType, accept: '*/*' },
      body: rendered.body,
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!res.ok) return { sent: false, status: res.status, error: `destination returned ${res.status}` };
    return { sent: true, status: res.status };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'delivery failed' };
  }
}

interface DeliveryBlock {
  id?: string;
  type?: string;
  key?: string;
  config?: Record<string, unknown>;
  label?: unknown;
}

const labelOf = (label: unknown, fallback: string): string => {
  if (typeof label === 'string' && label.trim()) return label;
  if (Array.isArray(label)) {
    const text = label.map((part) => (typeof part === 'string' ? part : '')).join('').trim();
    if (text) return text;
  }
  return fallback;
};

const optionLabel = (config: Record<string, unknown> | undefined, id: string): string => {
  const options = config?.options;
  if (!Array.isArray(options)) return id;
  const found = options.find((option) => option && typeof option === 'object' && (option as { id?: string }).id === id) as { label?: unknown } | undefined;
  return found ? labelOf(found.label, id) : id;
};

const columnSummary = (rows: Array<{ cells?: Record<string, string> }>, id: string, summary: string): number | undefined => {
  if (summary === 'count') return rows.filter((row) => row.cells?.[id] !== undefined && row.cells[id] !== '').length;
  const nums = rows.flatMap((row) => {
    const cell = row.cells?.[id];
    return cell !== undefined && /^-?\d+(\.\d+)?$/.test(cell) ? [Number(cell)] : [];
  });
  if (!nums.length) return undefined;
  if (summary === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (summary === 'average') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (summary === 'min') return Math.min(...nums);
  if (summary === 'max') return Math.max(...nums);
  return undefined;
};

/** A JSON value for one field. Lists become arrays of row objects; a configured summary is a sibling key. */
export function valueForField(block: DeliveryBlock, answer: unknown): unknown {
  const value = answer && typeof answer === 'object' && 'value' in answer ? (answer as { value: unknown }).value : answer;
  const config = block.config ?? {};
  if (value == null) return '';
  if (block.type === 'dynamic_table' && typeof value === 'object') {
    const table = value as { rows?: Array<{ cells?: Record<string, string> }>; addedColumns?: Array<{ id: string; label: string }> };
    const authored = Array.isArray(config.columns) ? config.columns as Array<{ id: string; label?: unknown; summary?: string; summaryLabel?: string }> : [];
    const columns = [
      ...authored.map((col) => ({ id: col.id, label: labelOf(col.label, col.id), summary: col.summary, summaryLabel: col.summaryLabel })),
      ...(table.addedColumns ?? []).map((col) => ({ id: col.id, label: col.label || col.id, summary: undefined, summaryLabel: undefined })),
    ];
    const rows = (table.rows ?? []).map((row) => Object.fromEntries(columns.map((col) => [col.label, row.cells?.[col.id] ?? ''])));
    const summary: Record<string, number> = {};
    for (const col of columns) {
      if (!col.summary || col.summary === 'none') continue;
      const result = columnSummary(table.rows ?? [], col.id, col.summary);
      if (result === undefined) continue;
      summary[col.summaryLabel?.trim() || `${col.label} ${col.summary}`] = result;
    }
    return Object.keys(summary).length ? { rows, summary } : { rows };
  }
  if (block.type === 'repeating_group' && typeof value === 'object') {
    const rows = (value as { rows?: Array<{ values?: Record<string, unknown> }> }).rows ?? [];
    return rows.map((row) => row.values ?? {});
  }
  if (block.type === 'single_choice' && typeof value === 'object') {
    const choice = value as { optionId?: string | null; other?: string };
    return choice.optionId ? optionLabel(config, choice.optionId) : choice.other ?? '';
  }
  if (block.type === 'multi_choice' && typeof value === 'object') {
    const choice = value as { optionIds?: string[]; other?: string };
    const labels = (choice.optionIds ?? []).map((id) => optionLabel(config, id));
    if (choice.other) labels.push(choice.other);
    return labels;
  }
  if (block.type === 'ranking' && Array.isArray(value)) return value.map((id) => optionLabel(config, String(id)));
  if (block.type === 'email' && typeof value === 'object') return (value as { address?: string }).address ?? '';
  if (block.type === 'phone' && typeof value === 'object') return (value as { e164?: string }).e164 ?? '';
  if (block.type === 'file_upload' && Array.isArray(value)) {
    return value.map((file) => (file && typeof file === 'object' ? { name: (file as { name?: string }).name ?? '', fileId: (file as { fileId?: string }).fileId ?? '' } : file));
  }
  if (block.type === 'signature' && typeof value === 'object') {
    const file = (value as { file?: { name?: string; fileId?: string } }).file;
    return { name: file?.name ?? '', fileId: file?.fileId ?? '' };
  }
  if (block.type === 'matrix' && typeof value === 'object') return (value as { rows?: unknown }).rows ?? value;
  return value;
}

/** One delivery value per answered field, using the published block type rather than the flattened text. */
export function deliveryFields(blocks: Record<string, unknown> | undefined, answers: Record<string, unknown>, fallback: DeliveryField[]): DeliveryField[] {
  if (!blocks) return fallback;
  const fields: DeliveryField[] = [];
  for (const block of Object.values(blocks)) {
    if (!block || typeof block !== 'object' || !('key' in block)) continue;
    const field = block as DeliveryBlock;
    if (!field.key || !field.id) continue;
    const answer = answers[field.id];
    if (answer === undefined) continue;
    fields.push({ key: field.key, value: valueForField(field, answer) });
  }
  return fields.length ? fields : fallback;
}
