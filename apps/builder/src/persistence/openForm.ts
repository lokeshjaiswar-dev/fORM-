import { defineMessages } from '@form/i18n';
import { FormDefinitionSchema, NOTE_MEANINGS, type FormDefinition, type FormId, type IsoInstant, type MigrationNote } from '@form/schema';
import { ApiProblem } from '@/auth/client';
import { t } from '@/i18n';
import { blankDefinition } from '@/lib/definition';
import { migrateDraft, readV1, type V1Read } from '@/lib/migrate';
import { LocalOpsSchema, defaultOps, legacyAccessOf, type LegacyAccess, type LocalOps } from '@/state/opsStore';
import type { LoadNote } from '@/state/uiStore';
import { getAccess, inputOf, saveAccess, setFormPassword } from '@/persistence/accessApi';
import { DOCUMENT_FORMAT, LEGACY_FORMAT, type DocumentRepository, type StoredForm } from '@/persistence/DocumentRepository';
import { createRemoteForm } from '@/persistence/draftsApi';

/**
 * An opened form: the v2 definition, its local FormOps and the notes to show. `migrated` says the stored draft was
 * v1 and has just been converted; the session saves the result once (BL-143). `legacy` is the password and/or closed
 * state the stored copy still held from before access settings lived on the server: `settleLegacyAccess` sends it to
 * the API and clears the local copy (BL-145).
 */
export type Opened = { ok: true; doc: FormDefinition; ops: LocalOps; notes: LoadNote[]; migrated: boolean; legacy?: LegacyAccess } | { ok: false; error: string };
export type OpenedForm = Extract<Opened, { ok: true }>;

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
  'load.access_moved': 'The password and closed setting this form kept in this browser are now settings on the server, under Access. The password is stored hashed and cannot be shown again.',
  'load.access_refused': 'The server did not accept the password or closed setting this form kept in this browser ({reason}). Set them again under Access.',
  'load.access_kept': 'The password and closed setting this form kept in this browser could not be sent to the server just now. They stay here and are sent the next time the form opens.',
  'load.access_lost': 'The password and closed setting from this form’s old file could not be sent to the server just now, and the converted form replaces the old copy. Set them again under Access.',
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

/** A v1 form as a v2 draft (schema §4.1): the definition, the FormOps it carried, and every note worth showing. */
function fromV1(read: V1Read, id: string, now: IsoInstant): Opened {
  let result;
  try {
    result = migrateDraft(read.form, id, now);
  } catch (e) {
    return { ok: false, error: t(M['load.migration_failed'], { reason: e instanceof Error ? e.message : String(e) }) };
  }
  const notes = result.notes.filter((n) => !routine(n)).map((n): LoadNote => ({ code: n.code, path: n.path, detail: `${NOTE_MEANINGS[n.code]}: ${n.detail}` }));
  // The password and the closed state are not part of the draft: they go to the API (`settleLegacyAccess`), never into a stored form.
  const access = result.ops.access;
  const legacy = legacyAccessOf({ open: access.enabled, closedMessage: access.screens.closed?.content, password: result.plaintextPasswordToHash ?? '' });
  return { ok: true, doc: { ...result.definition, formId: id as FormId }, ops: defaultOps(), notes: [...repairNotes(read.repairs), ...notes], migrated: true, ...(legacy ? { legacy } : {}) };
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
  // A copy an older build saved holds its password and closed state in `ops`; they are read here and never loaded into the store.
  const legacy = legacyAccessOf(form.ops);
  return { ok: true, doc: { ...(parsed.data as FormDefinition), formId: form.id as FormId }, ops: ops.success ? ops.data : defaultOps(), notes: [], migrated: false, ...(legacy ? { legacy } : {}) };
}

/** A v1 JSON export as a new form `id`: read by the lenient v1 reader and migrated once; its repairs and changes are the notes. */
export function importV1(input: unknown, id: string, now: IsoInstant): Opened {
  const read = readV1(input);
  if (!read.ok) return { ok: false, error: t(M['load.not_v1'], { reason: read.error }) };
  return fromV1(read.read, id, now);
}

/** What `settleLegacyAccess` needs besides the form: where it lives, and the repository whose copy it clears. */
export interface LegacyEnv {
  /** The org the form belongs to; null when nobody is signed in, and there is nothing to send to. */
  org: string | null;
  repo: Pick<DocumentRepository, 'save' | 'saveLocal'>;
}

/**
 * A refusal that retrying cannot fix: a password the server's rules reject, a form it will not take. A 401 (the session
 * ended), a 403 (no `ops.manage` yet), a 429 or a 5xx can pass, so those are tried again on the next open.
 */
const isFinalRefusal = (err: unknown): err is ApiProblem => err instanceof ApiProblem && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status);

/** Sends the legacy password and closed state to the API. The server wins where it already holds a value: an old local copy never overwrites settings someone has made since. */
async function sendLegacy(org: string, id: string, title: string, serverRev: number, legacy: LegacyAccess): Promise<void> {
  // A form that only exists in this browser has no row to hold settings yet; making it is what its first save does too.
  if (serverRev === 0) await createRemoteForm(org, id, title);
  const current = await getAccess(org, id);
  if (legacy.closed && current.rev === 0) {
    const screens = { ...current.screens, ...(legacy.closedMessage ? { closed: { content: legacy.closedMessage } } : {}) };
    await saveAccess(org, id, { ...inputOf(current), enabled: false, screens }, current.rev);
  }
  if (legacy.password !== '' && !current.hasPassword) await setFormPassword(org, id, legacy.password);
}

/**
 * Moves what a stored form still holds from before access settings lived on the server (BL-145): its plaintext
 * password and closed state go to the API (`PUT .../access`, `PUT .../access/password`), and once the server has taken
 * them, or refused them for good, the browser's copy is rewritten without them. The answer is the notes to show.
 *
 * A server that cannot be reached leaves the copy as it is, to try again at the next open: the password is not lost. A
 * v1 file is the exception, because the session replaces it with the converted v2 draft right after this, so its notes
 * say to set the password again. The caller saves the converted draft itself (`migrated`); a v2 copy is rewritten here,
 * in this browser only, without sending the draft to the server.
 */
export async function settleLegacyAccess(stored: StoredForm, opened: OpenedForm, env: LegacyEnv): Promise<LoadNote[]> {
  const { legacy } = opened;
  if (!legacy) return [];
  const note = (code: string, detail: string): LoadNote[] => [{ code, path: '/access', detail }];
  const unsent = () => note(opened.migrated ? 'access_lost' : 'access_kept', t(opened.migrated ? M['load.access_lost'] : M['load.access_kept']));
  if (env.org === null) return unsent();

  let refusal: ApiProblem | null = null;
  try {
    await sendLegacy(env.org, stored.id, opened.doc.title, stored.serverRev ?? 0, legacy);
  } catch (err) {
    if (!isFinalRefusal(err)) return unsent();
    refusal = err;
  }

  if (!opened.migrated) {
    const cleared: StoredForm = { ...stored, ops: defaultOps() };
    try {
      // Only this browser's copy is written: a draft with unsent changes stays dirty and a clean one stays clean.
      if (stored.dirty === true && env.repo.saveLocal) await env.repo.saveLocal(cleared);
      else await env.repo.save({ ...cleared, dirty: false });
    } catch {
      // The copy could not be rewritten now; the next open finds it again, and the server's own settings win then.
    }
  }
  return refusal
    ? note('access_refused', t(M['load.access_refused'], { reason: refusal.message || String(refusal.status) }))
    : note('access_moved', t(M['load.access_moved']));
}
