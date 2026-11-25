import {
  applyMapping,
  renderJson,
  renderXml,
  validateMapping,
  WEBHOOK_PAYLOAD_META,
  type WebhookPayloadMapping,
  type WebhookPayloadMeta,
} from '@form/schema';
import type { FormField } from '@/components/settings/webhookForm';

/*
 * The custom body of a webhook as the editor holds it, and the preview of it. The preview runs the same `applyMapping` and
 * renderers as the worker, over sample values, so what the owner sees is the shape the receiver gets. The preview never has a
 * real answer in it: the worker alone applies the mapping to the answers its disclosure filter allows.
 */

/** One row of the mapping table. `ref` is a field key for kind 'answer', a meta name for kind 'meta'. */
export interface MappingRow {
  path: string;
  kind: 'answer' | 'meta';
  ref: string;
}

/** The body settings the editor holds: the format, whether the owner shapes the body, the XML root and the mapping rows. */
export interface BodyValues {
  format: 'json' | 'xml';
  custom: boolean;
  root: string;
  rows: MappingRow[];
}

/** Whether the body settings can be saved: the standard payload always, a custom body when it maps something and every path is usable. */
export function bodyIsSaveable(value: BodyValues, fields: readonly FormField[]): boolean {
  if (!value.custom) return true;
  const mapping = mappingOf(value.rows, value.format === 'xml' ? value.root : '');
  return mapping.entries.length > 0 && previewOf(value.format, mapping, fields).issues.length === 0;
}

export const META_NAMES: readonly WebhookPayloadMeta[] = WEBHOOK_PAYLOAD_META;

const META_SAMPLES: Record<WebhookPayloadMeta, string> = {
  event: 'submission.created',
  eventId: '0193a5e0-7c1e-7a10-8f0e-000000000001',
  createdAt: '2026-01-15T10:00:00.000Z',
  formId: '0193a5e0-7c1e-7a10-8f0e-000000000002',
  submissionId: '0193a5e0-7c1e-7a10-8f0e-000000000003',
  submittedAt: '2026-01-15T09:59:58.000Z',
};

export function rowsOf(mapping: WebhookPayloadMapping | null): MappingRow[] {
  return (mapping?.entries ?? []).map((e): MappingRow => (e.source.kind === 'answer' ? { path: e.path, kind: 'answer', ref: e.source.key } : { path: e.path, kind: 'meta', ref: e.source.name }));
}

/** The mapping the rows stand for. Rows with no path or no source yet are left out; `root` only counts for XML. */
export function mappingOf(rows: readonly MappingRow[], root: string): WebhookPayloadMapping {
  const entries = rows
    .filter((r) => r.path.trim() !== '' && r.ref !== '')
    .map((r) => ({
      path: r.path.trim(),
      source: r.kind === 'answer' ? ({ kind: 'answer', key: r.ref } as const) : ({ kind: 'meta', name: r.ref as WebhookPayloadMeta } as const),
    }));
  return { ...(root.trim() ? { root: root.trim() } : {}), entries };
}

/** What stands in for an answer in the preview: two values when the path spreads over `[]`, one otherwise. */
function sampleFor(field: FormField | undefined, key: string, spread: boolean): unknown {
  const one = `${field?.label ?? key} (sample)`;
  return spread ? [`${one} 1`, `${one} 2`] : one;
}

export interface BodyPreview {
  text: string;
  /** Why the mapping cannot be saved: bad paths, clashes, a bad root name. */
  issues: string[];
}

export function previewOf(format: 'json' | 'xml', mapping: WebhookPayloadMapping, fields: readonly FormField[]): BodyPreview {
  const issues = validateMapping(mapping);
  if (issues.length > 0) return { text: '', issues };
  const answers: Record<string, unknown> = {};
  for (const entry of mapping.entries) {
    if (entry.source.kind !== 'answer') continue;
    const key = entry.source.key;
    answers[key] = sampleFor(fields.find((f) => f.key === key), key, entry.path.includes('[]'));
  }
  const { tree } = applyMapping(mapping, { answers, meta: META_SAMPLES });
  return { text: format === 'json' ? renderJson(tree, { pretty: true }) : renderXml(mapping.root ?? 'submission', tree, { pretty: true }), issues: [] };
}
