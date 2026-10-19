import { defineMessages } from '@form/i18n';
import { FormDefinitionSchema, NOTE_MEANINGS, type FormDefinition, type FormId, type IsoInstant, type MigrationNote, type RichDoc } from '@form/schema';
import { t } from '@/i18n';
import { blankDefinition } from '@/lib/definition';
import { migrateDraft, readV1, type V1Read } from '@/lib/migrate';
import { LocalOpsSchema, defaultOps, type LocalOps } from '@/state/opsStore';
import type { LoadNote } from '@/state/uiStore';
import { DOCUMENT_FORMAT, LEGACY_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';

/**
 * An opened form: the v2 definition, its local FormOps and the notes to show. `migrated` says the stored draft was
 * v1 and has just been converted; the session saves the result once (BL-143).
 */
export type Opened = { ok: true; doc: FormDefinition; ops: LocalOps; notes: LoadNote[]; migrated: boolean } | { ok: false; error: string };

const M = defineMessages('builder', {
  'load.unknown_format': 'This form was saved in the ‘{format}’ format, which this builder cannot read.',
  'load.unreadable': 'This form cannot be read: {reason}.',
  'load.not_v1': 'This file is not a v1 form: {reason}.',
  'load.migration_failed': 'This form could not be converted to the current format: {reason}.',
  'load.converted': 'This form was saved by an older version of the builder; it now uses the current format and was saved again.',
  'load.repaired_not_an_object': 'an entry that is not an object was skipped',
  'load.repaired_missing_id': 'a block without an id was skipped',
  'load.repaired_duplicate_id': 'a block with a repeated id was skipped',
  'load.repaired_unknown_type': 'a block of an unknown type was skipped',
  'load.repaired_unknown_key': 'an unknown key was dropped',
  'load.repaired_invalid_value': 'a value of the wrong type was removed',
  'load.repaired_defaulted': 'a missing value took its default',
  'load.password_kept': 'The password stays in this browser for the preview; the server hashes it when forms are saved there.',
});

const REPAIRS: Readonly<Record<string, string>> = {
  not_an_object: M['load.repaired_not_an_object'],
  missing_id: M['load.repaired_missing_id'],
  duplicate_id: M['load.repaired_duplicate_id'],
  unknown_type: M['load.repaired_unknown_type'],
  unknown_key: M['load.repaired_unknown_key'],
  invalid_value: M['load.repaired_invalid_value'],
  defaulted: M['load.repaired_defaulted'],
};

const repairNotes = (repairs: V1Read['repairs']): LoadNote[] =>
  repairs.map((r) => ({ code: `repaired_${r.reason}`, path: r.path, detail: REPAIRS[r.reason] ? t(REPAIRS[r.reason] as never) : r.reason }));

/** A new stored form: the blank definition, or `doc` (a form made from a template) under the id `id`. */
export function newStoredForm(id: string, savedAt: string, doc: FormDefinition = blankDefinition(id)): StoredForm {
  return { id, format: DOCUMENT_FORMAT, rev: 0, savedAt, doc: { ...doc, formId: id as FormId }, ops: defaultOps() };
}

/**
 * Notes `migrateV1ToV2` adds to every form whatever its content: the default purpose, default compliance and a key
 * made from each field's label. They describe v2 defaults, not a change to what the author built, so they are left
 * out; a generated block id (`key_generated` at `/blocks/<n>/id`) is still shown.
 */
const ROUTINE = new Set(['default_purpose_added', 'compliance_defaulted']);
const routine = (n: MigrationNote) => ROUTINE.has(n.code) || (n.code === 'key_generated' && n.path.endsWith('/key'));

const EMPTY: RichDoc = { type: 'doc', content: [] };

/** A v1 form as a v2 draft (schema §4.1): the definition, the FormOps it carried, and every note worth showing. */
function fromV1(read: V1Read, id: string, now: IsoInstant): Opened {
  let result;
  try {
    result = migrateDraft(read.form, id, now);
  } catch (e) {
    return { ok: false, error: t(M['load.migration_failed'], { reason: e instanceof Error ? e.message : String(e) }) };
  }
  const notes = result.notes.filter((n) => !routine(n)).map((n): LoadNote => ({ code: n.code, path: n.path, detail: `${NOTE_MEANINGS[n.code]}: ${n.detail}` }));
  const access = result.ops.access;
  const password = result.plaintextPasswordToHash ?? '';
  const ops: LocalOps = { open: access.enabled, closedMessage: access.screens.closed?.content ?? (access.enabled ? defaultOps().closedMessage : EMPTY), password };
  if (password) notes.push({ code: 'password_kept', path: '/settings/password', detail: t(M['load.password_kept']) });
  return { ok: true, doc: { ...result.definition, formId: id as FormId }, ops, notes: [...repairNotes(read.repairs), ...notes], migrated: true };
}

/**
 * Reads a stored form through the reader for its format. A v2 draft is checked against the strict definition twin;
 * a v1 draft goes through the v1 reader and `migrateV1ToV2` once, with every repair and change as a note, so a
 * document an older build saved never changes silently. The URL's id is the form's id (B23).
 */
export function openStored(form: StoredForm, now: IsoInstant): Opened {
  if (form.format === LEGACY_FORMAT) {
    const read = readV1(form.doc);
    if (!read.ok) return { ok: false, error: t(M['load.unreadable'], { reason: read.error }) };
    const opened = fromV1(read.read, form.id, now);
    return opened.ok ? { ...opened, notes: [{ code: 'converted_to_v2', path: '', detail: t(M['load.converted']) }, ...opened.notes] } : opened;
  }
  if (form.format !== DOCUMENT_FORMAT) return { ok: false, error: t(M['load.unknown_format'], { format: form.format }) };
  const parsed = FormDefinitionSchema.safeParse(form.doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: t(M['load.unreadable'], { reason: issue ? `${issue.path.join('/')}: ${issue.message}` : 'invalid' }) };
  }
  const ops = LocalOpsSchema.safeParse(form.ops);
  return { ok: true, doc: { ...(parsed.data as FormDefinition), formId: form.id as FormId }, ops: ops.success ? ops.data : defaultOps(), notes: [], migrated: false };
}

/** A v1 JSON export as a new form `id`: read by the lenient v1 reader and migrated once; its repairs and changes are the notes. */
export function importV1(input: unknown, id: string, now: IsoInstant): Opened {
  const read = readV1(input);
  if (!read.ok) return { ok: false, error: t(M['load.not_v1'], { reason: read.error }) };
  return fromV1(read.read, id, now);
}
