import { compile, projectForRuntime } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { blankDmsDefinition, dmsToAnswer, elementsToDefinition, type DmsElement } from '@form/registry/profiles/dms-v1';
import type {
  AnswerValue, Answers, BlockId, FieldBlock, FormDefinition, FormVersion, FormVersionId, InlineDoc, IsoInstant, OrgId, RuntimeFormVersion, StoredBlock, UserId,
} from '@form/schema';
import { editableFields, incrementDisplay, optionsFor, type Option, type UploadField, type UploadModel } from './model.ts';

/*
 * The form the renderer shows for an `init`: the translator's blocks (profile dms-v1) in two titled sections, with
 * auto-increment and read-only fields locked. Built from the model, the current values and the loaded options, so a
 * rebuild after options arrive or a re-init is a pure function of its inputs.
 */

export const SECTION_TITLES = { doctype: 'Document details', master: 'Master details' } as const;
const SECTION_IDS = { doctype: 'fp_section_doctype', master: 'fp_section_master' } as const;
const FORM_ID = 'fp_upload';

export interface RenderPlan {
  version: RuntimeFormVersion;
  /** The answers the renderer starts from, per block (a block id is the DMS field id). */
  initialAnswers: Answers;
  /** The same answers as JSON per editable field id, to tell later which one the person changed. */
  baseline: Record<string, string>;
}

export type PlanResult = { ok: true; plan: RenderPlan } | { ok: false; message: string };

const inline = (text: string): InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** The classic element in the dialect the translator reads: name = the field name, the options the parent sent or loaded. */
function toElement(field: UploadField, options: readonly Option[]): DmsElement {
  const base = { ...field.element, name: field.element.value, label: field.element.value } as DmsElement;
  if (field.increment) {
    // Read-only text whatever the number format of the counter (a prefix makes it text): no pattern, no range.
    return { ...base, type: 'textinput', numeric: true, specialChars: true, required: false, primary: false };
  }
  if (field.type === 'dropdown') return { ...base, options: options.map((o) => ({ name: o.name, value: o.value })) };
  return base;
}

export function wrapAnswer(block: FieldBlock, value: unknown): AnswerValue {
  return { type: block.type, value } as AnswerValue;
}

/** Pins the clock the renderer sees to the parent's `today` (DD-MM-YYYY), midday in India, so "today" never depends on this device. */
export function sessionStart(today: string): IsoInstant {
  return `${today.slice(6, 10)}-${today.slice(3, 5)}-${today.slice(0, 2)}T06:30:00Z` as IsoInstant;
}

export function planRender(
  model: UploadModel,
  values: Readonly<Record<string, string>>,
  loaded: Readonly<Record<string, readonly Option[]>>,
  given: Readonly<Record<string, string>>,
): PlanResult {
  const elements = model.fields.map((f) => toElement(f, optionsFor(f, loaded)));
  let def: FormDefinition = elementsToDefinition(elements, { formId: FORM_ID, title: '', locale: model.locale, base: blankDmsDefinition(FORM_ID, '', model.locale) });
  const blocks: Partial<Record<BlockId, StoredBlock>> = { ...def.blocks };
  const answers: Record<string, AnswerValue> = {};
  const baseline: Record<string, string> = {};
  const editable = new Set(editableFields(model).map((f) => f.id));
  for (const field of model.fields) {
    const block = blocks[field.id as BlockId];
    if (!block || block.type === 'unsupported') return { ok: false, message: `field ${field.id} could not be translated` };
    const locked = field.increment || model.readOnly;
    const fieldBlock = block as FieldBlock;
    blocks[field.id as BlockId] = { ...fieldBlock, ...(locked ? { readOnly: true, required: false } : {}) } as StoredBlock;
    if (field.increment) {
      const shown = incrementDisplay(model, field, given);
      if (shown !== '') answers[field.id] = wrapAnswer(fieldBlock, shown);
      continue;
    }
    if (!editable.has(field.id)) continue;
    const answer = dmsToAnswer(fieldBlock, values[field.id] ?? '');
    if (answer !== undefined) answers[field.id] = wrapAnswer(fieldBlock, answer);
    baseline[field.id] = JSON.stringify(answers[field.id] ?? null);
  }
  const children: BlockId[] = [];
  for (const section of ['doctype', 'master'] as const) {
    const ids = model.fields.filter((f) => f.section === section).map((f) => f.id as BlockId);
    if (ids.length === 0) continue;
    const id = SECTION_IDS[section] as BlockId;
    blocks[id] = { id, type: 'section', config: { title: inline(SECTION_TITLES[section]), children: ids, collapsible: false } } as StoredBlock;
    children.push(id);
  }
  const [first, ...rest] = def.pages;
  def = {
    ...def,
    blocks,
    pages: [{ ...first!, children }, ...rest],
    theme: { ...def.theme, tokens: { ...def.theme.tokens, density: 'compact', formWidth: 'wide' } },
  };
  const compiled = (() => {
    try {
      return compile(def, REGISTRY);
    } catch (e) {
      return { ok: false as const, issues: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  })();
  if (!compiled.ok) return { ok: false, message: compiled.issues.map((i) => i.message).slice(0, 3).join('; ') || 'the form could not be compiled' };
  const stored: FormVersion = {
    id: 'fp-upload' as FormVersionId,
    orgId: 'fp-upload' as OrgId,
    formId: def.formId,
    number: 0,
    schemaVersion: def.schemaVersion,
    publishedAt: sessionStart(model.today),
    publishedBy: 'fp-upload' as UserId,
    definition: def,
    compiled: compiled.compiled,
    contentHash: compiled.compiled.definitionHash,
    templateLineage: [],
    variablesSnapshot: { variables: {} },
  };
  const version = projectForRuntime(stored, { state: 'open' }, {
    edition: 'airgapped',
    upload: { presignUrl: '', maxFileBytes: 0 },
    branding: false,
    thirdPartyTrackingAllowed: false,
  });
  return { ok: true, plan: { version, initialAnswers: answers as Answers, baseline } };
}
