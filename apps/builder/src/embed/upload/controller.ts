import { answerToDms } from '@form/registry/profiles/dms-v1';
import type { Answers, BlockId, FieldBlock } from '@form/schema';
import type { InboundMessage, OutboundType, PayloadOf } from '../bridge/protocol.ts';
import { buildModel, editableFields, fieldOf, initialValues, validateValues, type Option, type UploadField, type UploadModel } from './model.ts';
import { planRender, type RenderPlan } from './plan.ts';

/*
 * The child's behaviour behind the wire, with no React and no `window`: messages in, messages out, and one thing to
 * show (`onRender`). The page (DmsUploadPage.tsx) connects it to the transport and to the renderer.
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
  send<T extends OutboundType>(type: T, payload: PayloadOf<T>, replyTo?: string): string;
  /** The form to show, or `null` when there is none (before init, after a re-init the child cannot show). */
  onRender(view: RenderView | null): void;
  /** Shows the renderer's own inline errors on the fields; best effort, never decides `valid`. */
  showInlineErrors?(): Promise<unknown>;
  setTimer?(fn: () => void, ms: number): () => void;
}

export const CHANGE_DEBOUNCE_MS = 150;
/** Demo cap on options per dropdown (DESIGN section 4). */
export const MAX_OPTIONS = 500;
const INLINE_ERRORS_TIMEOUT_MS = 1500;

interface State {
  model: UploadModel;
  /** `init.values` as sent, for an auto-increment field's display in edit mode. */
  given: Record<string, string>;
  values: Record<string, string>;
  loaded: Record<string, Option[]>;
  plan: RenderPlan;
  revision: number;
}

interface PendingOptions {
  fieldId: string;
  gen: number;
  page: number;
  parentValue: string | null;
  collected: Option[];
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export class UploadController {
  private state: State | null = null;
  private revision = 0;
  private cancelChange: (() => void) | null = null;
  private readonly pending = new Map<string, PendingOptions>();
  private readonly generation = new Map<string, number>();

  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  receive(message: InboundMessage): void {
    switch (message.type) {
      case 'init':
        return this.onInit(message.id, message.payload);
      case 'options.result':
        return this.onOptions(message.replyTo, message.payload);
      case 'validate':
        void this.onValidate(message.id);
    }
  }

  /** A failure the page found while rendering. */
  fail(code: PayloadOf<'error'>['code'], message: string, fatal = true): void {
    this.deps.send('error', { code, message: message.slice(0, 500), fatal });
  }

  dispose(): void {
    this.reset();
    this.state = null;
  }

  private timer(fn: () => void, ms: number): () => void {
    return (this.deps.setTimer ?? defaultTimer)(fn, ms);
  }

  private reset(): void {
    this.cancelChange?.();
    this.cancelChange = null;
    this.pending.clear();
    this.generation.clear();
  }

  private onInit(replyTo: string, init: PayloadOf<'init'>): void {
    this.reset();
    const built = buildModel(init);
    if (!built.ok) {
      this.state = null;
      this.deps.onRender(null);
      this.deps.send('error', { code: 'invalid_init', message: built.message.slice(0, 500), fatal: true });
      return;
    }
    const { model } = built;
    if (model.unsupported.length > 0) {
      // The parent falls back to its own renderer; there is nothing to show here.
      this.state = null;
      this.deps.onRender(null);
      this.deps.send('initialized', { fieldCount: model.fields.length, unsupported: model.unsupported }, replyTo);
      return;
    }
    const values = initialValues(model, init.values);
    const loaded: Record<string, Option[]> = {};
    const planned = planRender(model, values, loaded, init.values);
    if (!planned.ok) {
      this.state = null;
      this.deps.onRender(null);
      this.deps.send('error', { code: 'render_failed', message: planned.message.slice(0, 500), fatal: true });
      return;
    }
    this.revision += 1;
    this.state = { model, given: { ...init.values }, values, loaded, plan: planned.plan, revision: this.revision };
    this.deps.onRender({ revision: this.revision, locale: model.locale, plan: planned.plan });
    this.deps.send('initialized', { fieldCount: model.fields.length, unsupported: [] }, replyTo);
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
      changed.push(field);
    }
    if (changed.length === 0) return;
    for (const field of changed) {
      for (const dependent of state.model.fields) {
        if (dependent.parentId !== null && fieldOf(state.model, dependent.parentId)?.id === field.id) this.fetchOptions(dependent);
      }
    }
    this.scheduleChange();
  }

  private errors() {
    const state = this.state!;
    return validateValues(state.model, state.values, state.loaded);
  }

  private emitChange(): void {
    this.cancelChange?.();
    this.cancelChange = null;
    const state = this.state;
    if (!state) return;
    this.deps.send('change', { values: { ...state.values }, valid: this.errors().length === 0 });
  }

  private scheduleChange(): void {
    this.cancelChange?.();
    this.cancelChange = this.timer(() => this.emitChange(), CHANGE_DEBOUNCE_MS);
  }

  private async onValidate(replyTo: string): Promise<void> {
    const state = this.state;
    if (!state) {
      this.deps.send('error', { code: 'internal', message: 'validate before a usable init', fatal: false });
      return;
    }
    // The parent caches `change.values` for its fallback: make sure it holds the latest before the verdict.
    if (this.cancelChange) this.emitChange();
    await this.showInline();
    if (this.state !== state) return; // re-initialised meanwhile; the parent's validate timeout covers it
    const errors = this.errors();
    this.deps.send('validated', { valid: errors.length === 0, errors, values: { ...state.values } }, replyTo);
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
    const id = this.deps.send('options.request', { fieldId: next.fieldId, parentValue: next.parentValue, page: next.page, search: '' });
    this.pending.set(id, next);
  }

  private onOptions(replyTo: string, result: PayloadOf<'options.result'>): void {
    const state = this.state;
    const open = this.pending.get(replyTo);
    if (!state || !open) return;
    this.pending.delete(replyTo);
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
    if (stale) this.scheduleChange();
  }
}
