import { NOTE_MEANINGS, parseV1, type IsoInstant, type MigrationNote, type V1 } from '@form/schema';
import { migrateForBuilder } from '@/lib/preview';
import type { FormSchema } from '@/types/form';
import { emptyForm } from '@/state/documentStore';
import type { LoadNote } from '@/state/uiStore';
import { DOCUMENT_FORMAT, type StoredForm } from '@/persistence/DocumentRepository';

export type Opened = { ok: true; doc: FormSchema; notes: LoadNote[] } | { ok: false; error: string };

const REPAIRS: Record<V1.V1Repair['reason'], string> = {
  not_an_object: 'an entry that is not an object was skipped',
  missing_id: 'a block without an id was skipped',
  duplicate_id: 'a block with a repeated id was skipped',
  unknown_type: 'a block of an unknown type was skipped',
  unknown_key: 'an unknown key was dropped',
  invalid_value: 'a value of the wrong type was removed',
  defaulted: 'a missing value took its default',
};

/* The builder's v1 types name the `customize` keys it writes; the v1 reader keeps `customize` free-form, as v1 did. */
const asBuilderForm = (form: V1.FormSchema, id: string): FormSchema => ({ ...(form as FormSchema), id });

const repairNotes = (repairs: V1.V1Repair[]): LoadNote[] => repairs.map((r) => ({ code: `repaired_${r.reason}`, path: r.path, detail: REPAIRS[r.reason] }));

/** A new, empty stored form. */
export function newStoredForm(id: string, savedAt: string): StoredForm {
  return { id, format: DOCUMENT_FORMAT, rev: 0, savedAt, doc: emptyForm(id) };
}

/**
 * Notes `migrateV1ToV2` adds to every form whatever its content: the default purpose, default compliance and a key
 * made from each field's label. They describe v2 defaults, not a change to what the author built, so a load leaves them
 * out; a generated block id (`key_generated` at `/blocks/<n>/id`) is still shown.
 */
const ROUTINE = new Set(['default_purpose_added', 'compliance_defaulted']);
const routine = (n: MigrationNote) => ROUTINE.has(n.code) || (n.code === 'key_generated' && n.path.endsWith('/key'));

/**
 * What the v2 migration changes in this form (schema §4.1: builder load goes through `migrateV1ToV2`). The draft
 * itself stays the v1 form the UI edits until WP-0.11b (BL-143), so the result is shown, not stored.
 */
function migrationNotes(form: V1.FormSchema, now: IsoInstant): LoadNote[] {
  try {
    return migrateForBuilder(form, now).notes
      .filter((n) => !routine(n))
      .map((n): LoadNote => ({ code: n.code, path: n.path, detail: `${NOTE_MEANINGS[n.code]}: ${n.detail}` }));
  } catch (e) {
    /* The draft does not depend on the migration result, so a migration bug must not lock the author out of the form. */
    const reason = e instanceof Error ? e.message : String(e);
    return [{ code: 'migration_failed', path: '', detail: `The v2 migration failed on this form, so its preview may be wrong: ${reason}` }];
  }
}

/**
 * Reads a stored form through the reader for its format, then runs the v1 → v2 migration over it. Every repair the
 * reader makes and every change the migration makes is a note, so a document an older build saved never changes
 * silently. The URL's id is the form's id (B23).
 */
export function openStored(form: StoredForm, now: IsoInstant): Opened {
  if (form.format !== DOCUMENT_FORMAT) return { ok: false, error: `This form was saved in the '${form.format}' format, which this builder cannot read.` };
  const parsed = parseV1(form.doc);
  if (!parsed.success) return { ok: false, error: `This form cannot be read: ${parsed.error}.` };
  return { ok: true, doc: asBuilderForm(parsed.data, form.id), notes: [...repairNotes(parsed.repairs), ...migrationNotes({ ...parsed.data, id: form.id }, now)] };
}

/**
 * A v1 JSON export as a new form `id`, read by the lenient v1 reader. Its repairs are the import's notes; the
 * migration notes come from `openStored` when the imported form opens. The password, closed state and logo and cover
 * URLs stay in the v1 document, so nothing the migration leaves to its caller is lost (BL-107).
 */
export function importV1(input: unknown, id: string): Opened {
  const parsed = parseV1(input);
  if (!parsed.success) return { ok: false, error: `This file is not a v1 form: ${parsed.error}.` };
  return { ok: true, doc: asBuilderForm(parsed.data, id), notes: repairNotes(parsed.repairs) };
}
