import { z } from 'zod';
import { checkDmsV1, definitionToElements, elementsToDefinition, type DmsElement, type ProfileIssue } from '@form/registry/profiles/dms-v1';
import type { FormDefinition } from '@form/schema';
import { BUILDER_LOCALE } from '@/i18n';
import { blankDefinition } from '@/lib/definition';
import { DOCUMENT_FORMAT, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { FieldUsageSchema, type FieldUsage } from '@/embed/contract';
import { createDmsClient, type DmsClient } from '@/embed/dmsClient';
import { removalCountChangedOf, schemaSyncOf } from '@/embed/master/describeDmsError';
import type { ResolvedLaunch } from '@/embed/launch';

/*
 * Master-mode persistence (DESIGN section 5). The builder's autosave writes to this repository's local memory only:
 * nothing reaches DMS until the author presses "Save to DMS", which calls `commit`. Each DMS save can add columns to
 * the master's table, so it is never automatic. No fORM- API or Postgres writes happen in this mode.
 */

export const MASTER_FORM_PATH = '/dms/v1/master/form';
export const NEW_MASTER_ID = 'new';

/** What `GET .../master/form/{id}` answers: `data` is dms-api's `getById()` (SEC-DESIGN 5.2.3 adds the two visibility fields). */
const MasterEnvelope = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    source: z.string().nullish(),
    updated_at: z.string().nullish(),
    doctype_ids: z.array(z.string()).nullish(),
    folder_ids: z.array(z.string()).nullish(),
    form_builder_fields: z.union([z.array(z.record(z.string(), z.unknown())), z.string()]).nullish(),
    /** Hidden fields left out of THIS answer (a reader who cannot reveal them): they are kept by dms-api, never sent back. */
    hidden_field_count: z.number().int().min(0).nullish(),
    can: z.looseObject({ reveal_fields: z.boolean().nullish() }).nullish(),
  }),
});

/** What a save answers: the id and the new lock token are all the page needs (the PATCH answer has no name). */
const SaveEnvelope = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().nullish(),
    updated_at: z.string().nullish(),
  }),
});

/** The fields DMS holds for the master as this reader sees them: id -> name. Hidden fields a reader cannot reveal are not in it. */
export type ServerFields = ReadonlyMap<string, string>;

export interface ServerMaster {
  id: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  /** What DMS stores, as of the last load or save: a block with one of these ids "exists in DMS" (removal needs consent). */
  fields: ServerFields;
  /** Hidden fields the reader cannot see and DMS keeps untouched (banner "N hidden fields you cannot see are kept"). */
  hiddenFieldCount: number;
  /** `can.reveal_fields` of the GET answer; null when DMS did not say (the launch context's value applies). */
  canReveal: boolean | null;
}

/** `commit` refused before any request: the definition is not something DMS can hold. */
export class DmsCommitRefused extends Error {
  readonly issues: ProfileIssue[];
  /** True when only warnings stand in the way: the author saves again to accept them (`confirmedWarnings` = `warningKey`). */
  readonly needsConfirmation: boolean;
  readonly warningKey: string;
  constructor(issues: ProfileIssue[], needsConfirmation = false) {
    super(issues.find((i) => i.severity === 'error')?.message ?? 'Settings DMS cannot keep are listed; save again to continue without them.');
    this.name = 'DmsCommitRefused';
    this.issues = issues;
    this.needsConfirmation = needsConfirmation;
    this.warningKey = warningKeyOf(issues);
  }
}

/** Identifies a set of warnings, so "save anyway" accepts exactly the ones the author saw. */
export const warningKeyOf = (issues: readonly ProfileIssue[]): string =>
  JSON.stringify(issues.filter((i) => i.severity === 'warning').map((i) => [i.code, i.blockId ?? '', i.message]));

/** One field the author deleted that DMS still stores: what the consent dialog tells them before anything is sent. */
export interface RemovalNeed {
  fieldId: string;
  /** The name DMS stores (the author must type it exactly). */
  name: string;
  /** Records holding a value in this field right now (`field-usage`), or the count a `REMOVAL_COUNT_CHANGED` reported. */
  count: number;
  /** True when this is a second ask, after more records came to hold a value (409 `REMOVAL_COUNT_CHANGED`). */
  recount: boolean;
}

/**
 * Asks the author about one field: resolves with the name they typed, or `null` when they cancelled. Called once per field, in order;
 * nothing is sent until every field was confirmed.
 */
export type AskRemoval = (need: RemovalNeed) => Promise<string | null>;

/** One entry of the PATCH's `remove[]` (SEC-DESIGN 7.3). */
export interface RemovalConsent {
  field_id: string;
  confirmed_name: string;
  confirmed_count: number;
}

export interface CommitOptions {
  /** The `warningKey` of the warnings the author has accepted. */
  confirmedWarnings?: string | null | undefined;
  /** How the page asks for removal consent. Without it a save that would remove a stored field is refused (`RemovalRequired`). */
  askRemoval?: AskRemoval | undefined;
}

/** The author cancelled a removal dialog: nothing was sent, and the page puts the block back. */
export class RemovalCancelled extends Error {
  readonly fieldId: string;
  constructor(fieldId: string) {
    super('The removal was cancelled, so nothing was saved.');
    this.name = 'RemovalCancelled';
    this.fieldId = fieldId;
  }
}

/**
 * The document no longer lists fields DMS stores and there is nobody to ask: refused before any request. fORM- never relies on
 * omission to remove a field (SEC-DESIGN 7.3), so this is a programming error, not something an author can cause.
 */
export class RemovalRequired extends Error {
  readonly fieldIds: string[];
  constructor(fieldIds: string[]) {
    super('A field that DMS stores is no longer in the form. Removing it needs the author to confirm it by name, so nothing was saved.');
    this.name = 'RemovalRequired';
    this.fieldIds = fieldIds;
  }
}

/** `source !== 'formplus'`: an OpenForm or classic-native master not converted yet (DEC-04.3). dms-api refuses its PATCH (`MASTER_NOT_CONVERTED`), so nothing is editable here. */
export class NotAFormPlusMaster extends Error {
  constructor(source: string | null) {
    super(`This master has not been moved to Forms+ yet${source ? ` (it was made with ${source})` : ''}. An administrator converts masters that were built in OpenForm or in classic DMS.`);
    this.name = 'NotAFormPlusMaster';
  }
}

export interface CommitResult {
  masterId: string;
  updatedAt: string | null;
  /** Settings the translation left out (the author was told before saving). */
  warnings: ProfileIssue[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function elementsOf(raw: unknown): DmsElement[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw new Error('DMS sent a form this builder cannot read.');
    }
  }
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('DMS sent a form this builder cannot read.');
  return list.filter(isRecord) as DmsElement[];
}

/** The name DMS stores for an element (what the author must type to remove it). */
const nameOfElement = (el: DmsElement): string => String(el.name ?? el.label ?? el.value ?? '');

/** id -> name of every element of a form. */
function fieldsOf(elements: readonly DmsElement[]): ServerFields {
  return new Map(elements.map((el) => [String(el.id), nameOfElement(el)]));
}

/** Most re-asks one save makes after `REMOVAL_COUNT_CHANGED`: the count only ever grows while the author is typing, so this is a safety stop. */
const MAX_REASKS = 5;

export class DmsMasterRepository implements DocumentRepository {
  private readonly client: DmsClient;
  private readonly local = new Map<string, StoredForm>();
  private server: ServerMaster | null = null;
  private inFlight: Promise<CommitResult> | null = null;
  /** The error `load` last threw, so the page can tell "sign in again" from "cannot open this master". */
  lastLoadError: unknown = null;

  private readonly launch: ResolvedLaunch;

  constructor(launch: ResolvedLaunch, client?: DmsClient) {
    this.launch = launch;
    this.client = client ?? createDmsClient({ apiBase: launch.apiBase, tenantId: launch.tenantId, workspaceId: launch.workspaceId });
  }

  /** The form id this repository serves: the master's id, or `new` for a master that does not exist yet. */
  get formId(): string {
    return this.launch.masterId ?? NEW_MASTER_ID;
  }

  list(): Promise<FormSummary[]> {
    return Promise.resolve([]);
  }

  async load(id: string): Promise<StoredForm | null> {
    const kept = this.local.get(id);
    if (kept) return kept;
    try {
      const form = await this.fetchForm(id);
      this.lastLoadError = null;
      return form;
    } catch (e) {
      this.lastLoadError = e;
      throw e;
    }
  }

  private async fetchForm(id: string): Promise<StoredForm> {
    const now = new Date().toISOString();
    const base = blankDefinition(id);
    const locale = BUILDER_LOCALE;
    if (this.launch.masterId === undefined) {
      const doc = elementsToDefinition([], { formId: id, title: this.launch.master?.name ?? '', locale, base });
      return { id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc };
    }
    const response = await this.client.request('GET', `${MASTER_FORM_PATH}/${encodeURIComponent(this.launch.masterId)}`);
    const parsed = MasterEnvelope.safeParse(response);
    if (!parsed.success) throw new Error('DMS sent a master this builder cannot read.');
    const { data } = parsed.data;
    if (data.source !== 'formplus') throw new NotAFormPlusMaster(data.source ?? null);
    const elements = elementsOf(data.form_builder_fields);
    this.server = {
      id: data.id,
      name: data.name,
      source: data.source,
      updatedAt: data.updated_at ?? null,
      fields: fieldsOf(elements),
      hiddenFieldCount: data.hidden_field_count ?? 0,
      canReveal: typeof data.can?.reveal_fields === 'boolean' ? data.can.reveal_fields : null,
    };
    const doc = elementsToDefinition(elements, { formId: id, title: data.name, locale, base });
    return { id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc };
  }

  /** Autosave target: this page's memory. Never a request. */
  save(form: StoredForm): Promise<void> {
    this.local.set(form.id, form);
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.local.delete(id);
    return Promise.resolve();
  }

  /** The master as DMS knows it after the last load or save. */
  get current(): ServerMaster | null {
    return this.server;
  }

  /**
   * `GET .../master/form/{id}/field-usage` (SEC-DESIGN 7.2): how many records hold a value in each field. Counts only, never values.
   * A reader who cannot reveal hidden fields does not get them listed (they cannot be removed by that reader anyway).
   */
  async fieldUsage(): Promise<FieldUsage> {
    const id = this.server?.id ?? this.launch.masterId;
    if (id === undefined) throw new Error('This master does not exist in DMS yet, so there is nothing to count.');
    const response = await this.client.request('GET', `${MASTER_FORM_PATH}/${encodeURIComponent(id)}/field-usage`);
    const parsed = z.object({ data: FieldUsageSchema }).safeParse(response);
    if (!parsed.success) throw new Error('DMS sent field counts this builder cannot read, so nothing was removed.');
    return parsed.data.data;
  }

  /**
   * "Save to DMS": the guard first, then `POST` (a new master) or `PATCH` (with `updated_at`, so a master someone else
   * changed answers 409 `MASTER_CHANGED` instead of being overwritten). One save at a time.
   *
   * A PATCH always lists every field the form keeps in `form_builder_fields`, and names every stored field it drops in `remove[]`
   * (SEC-DESIGN 7.3): fORM- never removes a field by leaving it out. Before anything is sent, `askRemoval` is asked once per such field
   * (the author types its name); a cancel throws `RemovalCancelled` and nothing is sent.
   */
  commit(doc: FormDefinition, options: CommitOptions = {}): Promise<CommitResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.doCommit(doc, options).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doCommit(doc: FormDefinition, options: CommitOptions): Promise<CommitResult> {
    const name = doc.title.trim();
    const issues = checkDmsV1(doc);
    if (name === '') issues.unshift({ severity: 'error', code: 'master_name_empty', path: '/title', message: 'Give the master a name (the form title).' });
    else if (name.length > 255) issues.unshift({ severity: 'error', code: 'master_name_too_long', path: '/title', message: 'A master name is at most 255 characters.' });
    if (issues.some((i) => i.severity === 'error')) throw new DmsCommitRefused(issues);
    const warnings = issues.filter((i) => i.severity === 'warning');
    if (warnings.length > 0 && options.confirmedWarnings !== warningKeyOf(warnings)) throw new DmsCommitRefused(warnings, true);

    const fields = definitionToElements(doc);
    const existing = this.server;
    const masterId = existing?.id ?? this.launch.masterId;
    // An edit is only ever sent for a master this repository loaded: without what DMS holds it cannot tell what a PATCH would drop.
    if (masterId !== undefined && existing === null) throw new Error('This master was not loaded from DMS, so it cannot be saved.');
    const kept = new Set(fields.map((el) => String(el.id)));
    const omitted = existing === null ? [] : [...existing.fields.keys()].filter((id) => !kept.has(id));
    const consents = new Map<string, RemovalConsent>();
    if (omitted.length > 0) {
      if (options.askRemoval === undefined) throw new RemovalRequired(omitted);
      await this.consentTo(omitted, options.askRemoval, consents);
    }

    let response: unknown;
    for (let asked = 0; ; asked += 1) {
      try {
        response = await this.send(masterId, existing, name, fields, [...consents.values()]);
        break;
      } catch (e) {
        /* More records now hold a value: the author is asked again with the new count, and only then is the save repeated. */
        if (asked < MAX_REASKS && options.askRemoval !== undefined && removalCountChangedOf(e) !== null && (await this.reask(e, options.askRemoval, consents))) continue;
        /* The metadata is committed and the lock token moved: adopt both, so "save again" PATCHes with the new token (never a second POST). */
        const sync = schemaSyncOf(e);
        const savedId = sync?.masterId ?? masterId;
        if (sync?.saved && savedId) {
          this.server = { id: savedId, name, source: 'formplus', updatedAt: sync.updatedAt ?? existing?.updatedAt ?? null, fields: fieldsOf(fields), hiddenFieldCount: existing?.hiddenFieldCount ?? 0, canReveal: existing?.canReveal ?? null };
        }
        throw e;
      }
    }
    const parsed = SaveEnvelope.safeParse(response);
    const data = parsed.success ? parsed.data.data : null;
    const id = data?.id ?? masterId;
    if (!id) throw new Error('DMS saved the master but did not say which one.');
    this.server = {
      id,
      name: data?.name ?? name,
      source: 'formplus',
      updatedAt: data?.updated_at ?? null,
      /* What DMS holds now is what was sent (removed fields are gone), plus the hidden fields it keeps and this reader never sees. */
      fields: fieldsOf(fields),
      hiddenFieldCount: existing?.hiddenFieldCount ?? 0,
      canReveal: existing?.canReveal ?? null,
    };
    return { masterId: id, updatedAt: this.server.updatedAt, warnings };
  }

  /** Counts, then one question per field in the order the form had them; fills `into` with the confirmations. */
  private async consentTo(ids: readonly string[], ask: AskRemoval, into: Map<string, RemovalConsent>): Promise<void> {
    const usage = await this.fieldUsage();
    const byId = new Map(usage.fields.map((f) => [f.id.toLowerCase(), f]));
    for (const id of ids) {
      const row = byId.get(id.toLowerCase());
      const name = row?.name ?? this.server?.fields.get(id) ?? '';
      await this.askOne({ fieldId: id, name, count: row?.records_with_value ?? 0, recount: false }, ask, into);
    }
  }

  private async askOne(need: RemovalNeed, ask: AskRemoval, into: Map<string, RemovalConsent>): Promise<void> {
    const typed = await ask(need);
    if (typed === null) throw new RemovalCancelled(need.fieldId);
    // The dialog only lets the exact name through; this is the same rule where a request is made, so no caller can skip it.
    if (typed !== need.name) throw new Error('The name typed does not match the field, so nothing was removed.');
    into.set(need.fieldId, { field_id: need.fieldId, confirmed_name: typed, confirmed_count: need.count });
  }

  /** After `REMOVAL_COUNT_CHANGED`: asks again for every field whose count grew past what was confirmed. False when nothing is left to ask. */
  private async reask(e: unknown, ask: AskRemoval, consents: Map<string, RemovalConsent>): Promise<boolean> {
    const changed = removalCountChangedOf(e);
    if (changed === null) return false;
    /* Ids compare without case, as in `consentTo` (a UUID may come back in either case); the consent keeps the id the form sent. */
    const consentOf = (id: string): RemovalConsent | undefined => consents.get(id) ?? [...consents.values()].find((c) => c.field_id.toLowerCase() === id.toLowerCase());
    const counts = new Map<RemovalConsent, number>();
    if (changed.fieldId !== null && changed.actual !== null) {
      const was = consentOf(changed.fieldId);
      if (was) counts.set(was, changed.actual);
    } else {
      // The answer did not say which field: count them all again.
      const usage = await this.fieldUsage();
      for (const f of usage.fields) {
        const was = consentOf(f.id);
        if (was) counts.set(was, f.records_with_value);
      }
    }
    let again = false;
    for (const [was, count] of counts) {
      if (count <= was.confirmed_count) continue;
      await this.askOne({ fieldId: was.field_id, name: was.confirmed_name, count, recount: true }, ask, consents);
      again = true;
    }
    return again;
  }

  private send(masterId: string | undefined, existing: ServerMaster | null, name: string, fields: DmsElement[], remove: readonly RemovalConsent[]): Promise<unknown> {
    return masterId === undefined
      ? this.client.request('POST', MASTER_FORM_PATH, {
          name,
          source: 'formplus',
          /* From the DMS wizard's choice (the ticket's master seed): an enum value or null, never anything the link made up. */
          classification: this.launch.master?.classification ?? null,
          doctype_ids: this.launch.master?.doctypeIds ?? [],
          folder_ids: this.launch.master?.folderIds ?? [],
          form_builder_fields: fields,
        })
      : this.client.request('PATCH', `${MASTER_FORM_PATH}/${encodeURIComponent(masterId)}`, {
          name,
          source: 'formplus',
          ...(existing?.updatedAt ? { updated_at: existing.updatedAt } : {}),
          form_builder_fields: fields,
          ...(remove.length > 0 ? { remove } : {}),
        });
  }
}
