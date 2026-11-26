import { answerToDms } from '@form/registry/profiles/dms-v1';
import type { RemoteLookupResult } from '@form/renderer';
import type { Answers, BlockId, FieldBlock } from '@form/schema';
import { prefillHash, type ChildBody, type InitMessage, type ParentMessage } from '../bridge/protocolV2.ts';
import { SECRET_MASK } from '../lookup/dmsRows.ts';
import { buildModel, editableFields, fieldOf, initialValues, validateValues, type Option, type UploadField, type UploadModel } from './model.ts';
import { planRender, type RenderPlan } from './plan.ts';

/*
 * The child's behaviour behind the wire (fp-bridge/2, SEC-DESIGN 3.4), with no React and no `window`: messages in, messages
 * out, and one thing to show (`onRender`). The page (UploadApp.tsx) connects it to the port and to the renderer.
 *
 * What differs from /1: answers never leave while the person types. The child tells the parent `state` ({valid, dirty,
 * touched ids}, no values) and puts the values in exactly one message, `collected`, once per `collect` request. A secret field is
 * never prefilled and an untouched one is absent from `collected.values`, so DMS keeps what it stores (SEC-DESIGN 5.3, T-60).
 *
 * State per `init` is a pure function of that init plus what the person types and the options the parent sends, and an
 * `init` replaces all of it (idempotent: a re-sent init with the same content gives the same form and values).
 */

/** What the page renders: bump of `revision` remounts the renderer with `plan`'s starting answers. */
export interface RenderView {
  revision: number;
  locale: string;
  plan: RenderPlan;
}

export interface ControllerDeps {
  /** Sends one child message on the port (the transport stamps `protocol` and checks the schema). */
  send(body: ChildBody): void;
  /** The form to show, or `null` when there is none (before init, after a re-init the child cannot show). */
  onRender(view: RenderView | null): void;
  /** The parent's channel id for this mount (the `port` message). `init` and `collect` for another dialog are dropped. */
  dialogId: string;
  /** Shows the renderer's own inline errors on the fields; best effort, never decides `valid`. */
  showInlineErrors?(): Promise<unknown>;
  setTimer?(fn: () => void, ms: number): () => void;
  /** A reason for logs (never sent): why an `error` was raised. */
  onProblem?(code: string, why: string): void;
}

export const STATE_DEBOUNCE_MS = 150;
/** Demo cap on options per dropdown (DESIGN section 4). */
export const MAX_OPTIONS = 500;
const INLINE_ERRORS_TIMEOUT_MS = 1500;
/** A lookup the parent does not answer in this time gives no rows (the person can type on). */
export const LOOKUP_TIMEOUT_MS = 8000;
/** `collect` requests remembered so a repeated `req` is answered once at most. */
const REMEMBERED_REQS = 64;
const NO_ROWS: RemoteLookupResult = { rows: [], truncated: false };

interface State {
  model: UploadModel;
  /** `init.values` as sent (a masked value is `null`), for an auto-increment field's display in edit mode. */
  given: Record<string, string | null>;
  values: Record<string, string>;
  /** The values the form started with, to tell `dirty`. */
  start: Record<string, string>;
  /** Fields the person changed at least once; a secret or masked field is sent back only when it is in here. */
  touched: Set<string>;
  loaded: Record<string, Option[]>;
  plan: RenderPlan;
  revision: number;
  /** Ids of the lookups this init declared: the only ones the child may ask the parent for. */
  lookups: ReadonlySet<string>;
  prefill: string;
}

interface PendingOptions {
  fieldId: string;
  gen: number;
  page: number;
  parentValue: string | null;
  collected: Option[];
}

interface PendingLookup {
  lookupId: string;
  settle: (result: RemoteLookupResult) => void;
  cancelTimeout: () => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export class UploadController {
  private state: State | null = null;
  private revision = 0;
  private sequence = 0;
  private cancelState: (() => void) | null = null;
  private readonly pending = new Map<string, PendingOptions>();
  private readonly generation = new Map<string, number>();
  /** `lookup.request` id -> what waits for its answer. One per lookup id: the newest request supersedes the older. */
  private readonly lookups = new Map<string, PendingLookup>();
  private readonly answered: string[] = [];

  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  receive(message: ParentMessage): void {
    switch (message.type) {
      case 'init':
        if (message.dialogId !== this.deps.dialogId) return this.deps.onProblem?.('dialog', 'init for another dialog');
        return this.onInit(message);
      case 'options.result':
        return this.onOptions(message);
      case 'lookup.result':
        return this.onLookupResult(message);
      case 'collect':
        if (message.dialogId !== this.deps.dialogId) return this.deps.onProblem?.('dialog', 'collect for another dialog');
        void this.onCollect(message.req);
    }
  }

  /** A failure the page found while rendering. `why` is for the log only: the wire carries the code and `fatal`. */
  fail(code: Extract<ChildBody, { type: 'error' }>['code'], why: string, fatal = true): void {
    this.deps.onProblem?.(code, why.slice(0, 500));
    this.deps.send({ type: 'error', code, fatal });
  }

  dispose(): void {
    this.reset();
    this.state = null;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString(36)}`;
  }

  private timer(fn: () => void, ms: number): () => void {
    return (this.deps.setTimer ?? defaultTimer)(fn, ms);
  }

  private reset(): void {
    this.cancelState?.();
    this.cancelState = null;
    this.pending.clear();
    this.generation.clear();
    this.settleLookups();
  }

  /** Ends every open lookup with no rows (a new init, a dispose). */
  private settleLookups(except?: string): void {
    for (const [id, open] of [...this.lookups]) {
      if (except !== undefined && open.lookupId !== except) continue;
      this.lookups.delete(id);
      open.cancelTimeout();
      open.settle(NO_ROWS);
    }
  }

  /**
   * Rows for what the person typed in a lookup's search field, asked of the parent as `lookup.request`. Nothing is sent
   * for a lookup this init did not declare (`init.lookups`) or before an init. One request is open per lookup (a newer one
   * supersedes the older, which gets no rows); no answer in 8 s gives no rows.
   */
  lookup(lookupId: string, search: string): Promise<RemoteLookupResult> {
    const state = this.state;
    const declared = state?.plan.version.definition.lookups?.find((l) => l.id === lookupId && l.source === 'dms_master');
    if (!state || !declared || !state.lookups.has(lookupId)) return Promise.resolve(NO_ROWS);
    this.settleLookups(lookupId);
    return new Promise<RemoteLookupResult>((resolve) => {
      const id = this.nextId('c-l');
      this.deps.send({ type: 'lookup.request', id, lookupId, search: search.slice(0, 100) });
      const cancelTimeout = this.timer(() => {
        this.lookups.delete(id);
        resolve(NO_ROWS);
      }, LOOKUP_TIMEOUT_MS);
      this.lookups.set(id, { lookupId, settle: resolve, cancelTimeout });
    });
  }

  /**
   * The parent's answer. Taken only for a request still open (an unknown or superseded `replyTo` is dropped) and only for the
   * lookup it was asked for. Cells are cut to the ids the lookup declares: the label column and the filled columns; a value
   * that is the DMS secret mask is dropped (the parent's projection does the same).
   */
  private onLookupResult(result: Extract<ParentMessage, { type: 'lookup.result' }>): void {
    const open = this.lookups.get(result.replyTo);
    if (!open || result.lookupId !== open.lookupId) return;
    this.lookups.delete(result.replyTo);
    open.cancelTimeout();
    const declared = this.state?.plan.version.definition.lookups?.find((l) => l.id === open.lookupId);
    if (result.status !== 'ok' || !declared) return open.settle(NO_ROWS);
    const keys = new Map([declared.pickerKey, ...declared.mappings.map((m) => m.key)].map((k) => [k.toLowerCase(), k]));
    const rows = result.rows.slice(0, declared.maxRows).flatMap((row) => {
      const label = row.label.trim();
      // The parent already drops masked values (dmsRows); a value that is still the mask is dropped here again.
      if (label === '' || label === SECRET_MASK) return [];
      const cells: Record<string, string> = {};
      for (const [key, text] of Object.entries(row.cells)) {
        const declaredKey = keys.get(key.toLowerCase());
        if (declaredKey !== undefined && text !== SECRET_MASK) cells[declaredKey] = text;
      }
      return [{ label, cells }];
    });
    open.settle({ rows, truncated: result.truncated });
  }

  private onInit(init: InitMessage): void {
    this.reset();
    const built = buildModel(init);
    if (!built.ok) {
      this.state = null;
      this.deps.onRender(null);
      this.fail('invalid_init', built.message);
      return;
    }
    const { model } = built;
    if (model.unsupported.length > 0) {
      // The parent falls back to its own (empty) renderer; there is nothing to show here.
      this.state = null;
      this.deps.onRender(null);
      this.deps.send({ type: 'initialized', dialogId: init.dialogId, fieldCount: model.fields.length, unsupported: model.unsupported });
      return;
    }
    const values = initialValues(model, init.values);
    const loaded: Record<string, Option[]> = {};
    const planned = planRender(model, values, loaded, init.values);
    if (!planned.ok) {
      this.state = null;
      this.deps.onRender(null);
      this.fail('render_failed', planned.message);
      return;
    }
    this.revision += 1;
    this.state = {
      model,
      given: { ...init.values },
      values,
      start: { ...values },
      touched: new Set(),
      loaded,
      plan: planned.plan,
      revision: this.revision,
      lookups: new Set(init.lookups),
      prefill: prefillHash(init.values, init.masked),
    };
    this.deps.onRender({ revision: this.revision, locale: model.locale, plan: planned.plan });
    this.deps.send({ type: 'initialized', dialogId: init.dialogId, fieldCount: model.fields.length, unsupported: [] });
    for (const field of model.fields) if (field.remoteOptions) this.fetchOptions(field);
  }

  /** The renderer's answers after an edit. Only a field whose answer changed overwrites the DMS string held for it. */
  setAnswers(answers: Answers): void {
    const state = this.state;
    if (!state) return;
    const changed: UploadField[] = [];
    for (const field of editableFields(state.model)) {
      const answer = answers[field.id as BlockId];
      const json = JSON.stringify(answer ?? null);
      if (json === state.plan.baseline[field.id]) continue;
      state.plan.baseline[field.id] = json;
      const block = state.plan.version.definition.blocks[field.id as BlockId] as FieldBlock;
      state.values[field.id] = answerToDms(block, answer?.value as never);
      state.touched.add(field.id);
      changed.push(field);
    }
    if (changed.length === 0) return;
    for (const field of changed) {
      for (const dependent of state.model.fields) {
        if (dependent.parentId !== null && fieldOf(state.model, dependent.parentId)?.id === field.id) this.fetchOptions(dependent);
      }
    }
    this.scheduleState();
  }

  private errors() {
    const state = this.state!;
    return validateValues(state.model, state.values, state.loaded, state.touched);
  }

  private isDirty(state: State): boolean {
    return editableFields(state.model).some((f) => (state.values[f.id] ?? '') !== (state.start[f.id] ?? '')) || state.touched.size > 0;
  }

  /** `state`: valid, dirty and which fields were touched. Never a value (SEC-DESIGN E2). */
  private emitState(): void {
    this.cancelState?.();
    this.cancelState = null;
    const state = this.state;
    if (!state) return;
    this.deps.send({ type: 'state', dialogId: this.deps.dialogId, valid: this.errors().length === 0, dirty: this.isDirty(state), touched: [...state.touched].slice(0, 200) });
  }

  private scheduleState(): void {
    this.cancelState?.();
    this.cancelState = this.timer(() => this.emitState(), STATE_DEBOUNCE_MS);
  }

  /**
   * `collect` -> exactly one `collected` for this `req`: the verdict and the values. A `req` seen before is ignored (a replay
   * gets nothing), as is one that arrives with no usable init (an `error` instead). The values leave here and nowhere else:
   * untouched secret and masked fields are left out, so the parent never sends a mask or a stale secret back.
   */
  private async onCollect(req: string): Promise<void> {
    if (this.answered.includes(req)) return;
    const state = this.state;
    if (!state) {
      this.fail('internal', 'collect before a usable init', false);
      return;
    }
    this.answered.push(req);
    if (this.answered.length > REMEMBERED_REQS) this.answered.shift();
    this.cancelState?.();
    this.cancelState = null;
    await this.showInline();
    if (this.state !== state) return; // re-initialised meanwhile; the parent's collect timeout covers it
    const errors = this.errors();
    const values: Record<string, string> = {};
    for (const field of editableFields(state.model)) {
      const hidden = field.secret || field.masked;
      if (hidden && !state.touched.has(field.id)) continue;
      const value = state.values[field.id] ?? '';
      // The mask is what DMS shows in place of a stored secret: typing it back is not a new value, and it is never sent (dms-api would refuse it).
      if (hidden && value === SECRET_MASK) continue;
      values[field.id] = value;
    }
    this.deps.send({ type: 'collected', dialogId: this.deps.dialogId, req, valid: errors.length === 0, errors, values, prefillHash: state.prefill });
  }

  private async showInline(): Promise<void> {
    const show = this.deps.showInlineErrors;
    if (!show) return;
    let cancel: (() => void) | undefined;
    const timeout = new Promise<void>((resolve) => {
      cancel = this.timer(resolve, INLINE_ERRORS_TIMEOUT_MS);
    });
    try {
      await Promise.race([show().catch(() => undefined), timeout]);
    } finally {
      cancel?.();
    }
  }

  /** Asks the parent for the field's options, from page 1; supersedes any request still open for the field. */
  private fetchOptions(field: UploadField): void {
    const state = this.state;
    if (!state) return;
    const gen = (this.generation.get(field.id) ?? 0) + 1;
    this.generation.set(field.id, gen);
    for (const [id, p] of this.pending) if (p.fieldId === field.id) this.pending.delete(id);
    const parent = field.parentId === null ? undefined : fieldOf(state.model, field.parentId);
    const parentValue = parent ? (state.values[parent.id] ?? '') : null;
    // A dependent dropdown has nothing to list until its parent has a value.
    if (parent && parentValue === '') {
      this.apply(field, []);
      return;
    }
    this.request({ fieldId: field.id, gen, page: 1, parentValue, collected: [] });
  }

  private request(next: PendingOptions): void {
    const id = this.nextId('c-o');
    this.pending.set(id, next);
    this.deps.send({ type: 'options.request', id, fieldId: next.fieldId, parentValue: next.parentValue === null ? null : next.parentValue.slice(0, 200), page: next.page, search: '' });
  }

  private onOptions(result: Extract<ParentMessage, { type: 'options.result' }>): void {
    const state = this.state;
    const open = this.pending.get(result.replyTo);
    if (!state || !open) return;
    this.pending.delete(result.replyTo);
    const field = fieldOf(state.model, open.fieldId);
    if (!field || result.fieldId.toLowerCase() !== open.fieldId.toLowerCase() || this.generation.get(open.fieldId) !== open.gen) return;
    const seen = new Set(open.collected.map((o) => o.value));
    const collected = [...open.collected];
    for (const o of result.options) {
      if (!seen.has(o.value) && collected.length < MAX_OPTIONS) {
        seen.add(o.value);
        collected.push({ name: o.name, value: o.value });
      }
    }
    if (result.hasMore && collected.length < MAX_OPTIONS && open.page < 100) {
      this.request({ ...open, page: open.page + 1, collected });
      return;
    }
    this.apply(field, collected);
  }

  /** Sets the field's options; a held value that is no longer a choice is cleared. Remounts the renderer only when something changed. */
  private apply(field: UploadField, options: Option[]): void {
    const state = this.state;
    if (!state) return;
    const before = JSON.stringify(state.loaded[field.id] ?? null);
    state.loaded[field.id] = options;
    const held = state.values[field.id] ?? '';
    const stale = held !== '' && (field.parentId !== null || options.length > 0) && !options.some((o) => o.value === held);
    if (stale) state.values[field.id] = '';
    if (!stale && JSON.stringify(options) === before) return;
    const planned = planRender(state.model, state.values, state.loaded, state.given);
    if (!planned.ok) {
      this.fail('render_failed', planned.message);
      return;
    }
    this.revision += 1;
    state.plan = planned.plan;
    state.revision = this.revision;
    this.deps.onRender({ revision: this.revision, locale: state.model.locale, plan: planned.plan });
    if (stale) this.scheduleState();
  }
}
