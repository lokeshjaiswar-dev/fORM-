import type { FormDefinition, IsoInstant } from '@form/schema';
import { importV1, openStored, type Opened } from '@/persistence/openForm';
import { DOCUMENT_FORMAT } from '@/persistence/DocumentRepository';

/*
 * Form JSON export and import. An export is an envelope `{ format, version, exportedAt, definition }` around the v2
 * definition. Import also accepts a bare v2 definition and a v1 JSON export. Every import is checked against the strict
 * schema (through `openStored`) before it is used, so a malformed file is refused with the reason, never half-loaded.
 * Local-only settings (the password, open/closed state) are not exported.
 */

export const FORM_JSON_FORMAT = 'dmacq-form';
export const FORM_JSON_VERSION = 2;

export interface FormJsonEnvelope {
  format: typeof FORM_JSON_FORMAT;
  version: typeof FORM_JSON_VERSION;
  exportedAt: string;
  definition: FormDefinition;
}

/** The export file's text for `doc`. */
export function serializeForm(doc: FormDefinition, now: Date = new Date()): string {
  const envelope: FormJsonEnvelope = {
    format: FORM_JSON_FORMAT,
    version: FORM_JSON_VERSION,
    exportedAt: now.toISOString(),
    definition: doc,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** A safe file name from the form title. */
export function formFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return `${slug || 'form'}.form.json`;
}

/** Saves the export text as a file in the browser. */
export function downloadFormJson(doc: FormDefinition): void {
  const blob = new Blob([serializeForm(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = formFileName(doc.title);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parses the text of an import file into a new form stored under `id`. Returns the opened form (validated v2 definition)
 * or a readable error. Never throws.
 */
export function parseFormJson(text: string, id: string, now: IsoInstant): Opened {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof SyntaxError ? err.message : 'the file is not valid JSON';
    return { ok: false, error: `This file is not valid JSON: ${reason}.` };
  }
  if (!isRecord(json)) return { ok: false, error: 'This file does not contain a form.' };

  // The export envelope, a bare v2 definition, or a v1 export (handled by the v1 reader).
  if (json.format === FORM_JSON_FORMAT) {
    if (json.version !== FORM_JSON_VERSION) {
      return { ok: false, error: `This form export is version ${String(json.version)}; this builder reads version ${FORM_JSON_VERSION}.` };
    }
    return checkV2(json.definition, id, now);
  }
  if ('schemaVersion' in json) return checkV2(json, id, now);
  return importV1(json, id, now);
}

function checkV2(definition: unknown, id: string, now: IsoInstant): Opened {
  if (!isRecord(definition)) return { ok: false, error: 'The form export has no form definition.' };
  const opened = openStored({ id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc: definition }, now);
  if (!opened.ok) return opened;
  return { ...opened, migrated: false };
}
