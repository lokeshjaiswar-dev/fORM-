import { z } from 'zod';
import { checkDmsV1, definitionToElements, elementsToDefinition, type DmsElement, type ProfileIssue } from '@form/registry/profiles/dms-v1';
import type { FormDefinition } from '@form/schema';
import { BUILDER_LOCALE } from '@/i18n';
import { blankDefinition } from '@/lib/definition';
import { DOCUMENT_FORMAT, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { createDmsClient, type DmsClient } from '@/embed/dmsClient';
import { schemaSyncOf } from '@/embed/master/describeDmsError';
import type { ResolvedLaunch } from '@/embed/launch';

/*
 * Master-mode persistence (DESIGN section 5). The builder's autosave writes to this repository's local memory only:
 * nothing reaches DMS until the author presses "Save to DMS", which calls `commit`. Each DMS save can add columns to
 * the master's table, so it is never automatic. No fORM- API or Postgres writes happen in this mode.
 */

export const MASTER_FORM_PATH = '/dms/v1/master/form';
export const NEW_MASTER_ID = 'new';

/** What `GET .../master/form/{id}` and a save answer: `data` is dms-api's `getById()`. */
const MasterEnvelope = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    source: z.string().nullish(),
    updated_at: z.string().nullish(),
    doctype_ids: z.array(z.string()).nullish(),
    folder_ids: z.array(z.string()).nullish(),
    form_builder_fields: z.union([z.array(z.record(z.string(), z.unknown())), z.string()]).nullish(),
  }),
});

export interface ServerMaster {
  id: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
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

export interface CommitOptions {
  /** The `warningKey` of the warnings the author has accepted. */
  confirmedWarnings?: string | null | undefined;
}

/** `source !== 'formplus'`: an OpenForm master not converted yet, or a classic master. dms-api refuses its PATCH (`MASTER_NOT_CONVERTED`), so nothing is editable here. */
export class NotAFormPlusMaster extends Error {
  constructor(source: string | null) {
    super(`This master has not been converted to Forms+${source ? ` (it was made with ${source})` : ''}. An administrator converts OpenForm masters; classic-built masters are edited in DMS classic.`);
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
    this.server = { id: data.id, name: data.name, source: data.source, updatedAt: data.updated_at ?? null };
    const doc = elementsToDefinition(elementsOf(data.form_builder_fields), { formId: id, title: data.name, locale, base });
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
   * "Save to DMS": the guard first, then `POST` (a new master) or `PATCH` (with `updated_at`, so a master someone else
   * changed answers 409 `MASTER_CHANGED` instead of being overwritten). One save at a time.
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
    let response: unknown;
    try {
      response = await this.send(masterId, existing, name, fields);
    } catch (e) {
      /* The metadata is committed and the lock token moved: adopt both, so "save again" PATCHes with the new token (never a second POST). */
      const sync = schemaSyncOf(e);
      const savedId = sync?.masterId ?? masterId;
      if (sync?.saved && savedId) this.server = { id: savedId, name, source: 'formplus', updatedAt: sync.updatedAt ?? existing?.updatedAt ?? null };
      throw e;
    }
    const parsed = MasterEnvelope.safeParse(response);
    const data = parsed.success ? parsed.data.data : null;
    const id = data?.id ?? masterId;
    if (!id) throw new Error('DMS saved the master but did not say which one.');
    this.server = { id, name: data?.name ?? name, source: 'formplus', updatedAt: data?.updated_at ?? null };
    return { masterId: id, updatedAt: this.server.updatedAt, warnings };
  }

  private send(masterId: string | undefined, existing: ServerMaster | null, name: string, fields: DmsElement[]): Promise<unknown> {
    return masterId === undefined
      ? this.client.request('POST', MASTER_FORM_PATH, {
          name,
          source: 'formplus',
          classification: null, // never from the link: dms-ui sends null too
          doctype_ids: this.launch.master?.doctypeIds ?? [],
          folder_ids: this.launch.master?.folderIds ?? [],
          form_builder_fields: fields,
        })
      : this.client.request('PATCH', `${MASTER_FORM_PATH}/${encodeURIComponent(masterId)}`, {
          name,
          source: 'formplus',
          ...(existing?.updatedAt ? { updated_at: existing.updatedAt } : {}),
          form_builder_fields: fields,
        });
  }
}
