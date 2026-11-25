import { BUILDER_LOCALE } from '@/i18n';
import { compile, projectForRuntime } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { blankDmsDefinition, dmsToAnswer, elementsToDefinition, type DmsElement } from '@form/registry/profiles/dms-v1';
import type {
  AnswerValue, Answers, BlockId, FieldBlock, FormDefinition, FormVersion, FormVersionId, IsoDate, IsoInstant, OrgId, RuntimeFormVersion, StoredBlock, UserId,
} from '@form/schema';
import { fieldNameOf, isIncrementElement, isLegacyElement, type DmsRecordValues } from './contract';

/*
 * The renderer form of one record: the master's elements (profile dms-v1) in canvas order, legacy and auto-increment
 * fields locked read-only, the loaded values as the starting answers. A pure function of its inputs.
 */

const FORM_ID = 'fp_record';
const LOCALE = BUILDER_LOCALE;

export interface RecordForm {
  version: RuntimeFormVersion;
  initialAnswers: Answers;
  /** Element id -> its starting answer as JSON, to tell which fields a person changed. */
  baseline: Record<string, string>;
  /** Element id -> the translated block, for `answerToDms`. */
  blocks: Record<string, FieldBlock>;
  /** The instant the renderer's session starts at (its `startedAt`), so its "today" is the one the default was seeded with. */
  startedAt: IsoInstant;
}

/** When the page is planned and where the viewer is: "today" is the viewer's calendar date (OpenForm prefill_today did the same). */
export interface RecordClock {
  now: IsoInstant;
  /** The viewer's IANA time zone. */
  timeZone: string;
}

/** The browser's own zone; UTC when the browser does not say. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const viewerClock = (): RecordClock => ({ now: new Date().toISOString() as IsoInstant, timeZone: viewerTimeZone() });

/** The calendar date of `now` in `timeZone`, by the renderer's own rule (`todayIn`, packages/renderer/src/eval/meta.ts); the UTC date for an unknown zone. */
export function localDate(now: IsoInstant, timeZone: string): IsoDate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date as IsoDate;
  } catch {
    /* An unknown zone falls through to UTC. */
  }
  return now.slice(0, 10) as IsoDate;
}

export type RecordFormResult = { ok: true; form: RecordForm } | { ok: false; message: string };

/** Auto-increment fields are read-only text whatever the counter's format (a prefix makes it text). */
const forRender = (el: DmsElement): DmsElement =>
  isIncrementElement(el) ? { ...el, type: 'textinput', numeric: true, specialChars: true, required: false, primary: false } : el;

export function planRecordForm(elements: readonly DmsElement[], values: DmsRecordValues, title: string, clock: RecordClock, recordId: string | null = null): RecordFormResult {
  const editing = recordId !== null;
  const today = localDate(clock.now, clock.timeZone);
  const translated = elements.map(forRender);
  let def: FormDefinition = elementsToDefinition(translated, { formId: FORM_ID, title, locale: LOCALE, base: blankDmsDefinition(FORM_ID, title, LOCALE) });
  const blocks: Partial<Record<BlockId, StoredBlock>> = { ...def.blocks };
  const answers: Record<string, AnswerValue> = {};
  const baseline: Record<string, string> = {};
  const byId: Record<string, FieldBlock> = {};
  for (const el of elements) {
    const id = String(el.id) as BlockId;
    const block = blocks[id];
    if (!block || block.type === 'unsupported') return { ok: false, message: `The field "${fieldNameOf(el)}" could not be shown.` };
    const locked = isLegacyElement(el) || isIncrementElement(el);
    let field = (locked ? { ...block, readOnly: true, required: false } : block) as FieldBlock;
    /* Edit shows and compares what DMS stores: a "today" default must not appear or count as a change. */
    if (editing && field.type === 'date' && field.config.defaultValue !== undefined) {
      const { defaultValue: _dropped, ...config } = field.config;
      field = { ...field, config } as FieldBlock;
    }
    blocks[id] = field as StoredBlock;
    byId[id] = field;
    const answer = dmsToAnswer(field, values[fieldNameOf(el)] ?? '');
    if (answer !== undefined) answers[id] = { type: field.type, value: answer } as AnswerValue;
    baseline[id] = JSON.stringify(answers[id] ?? null);
    /* Add: the default the screen shows is part of the starting answers, so it is what gets posted. */
    if (!editing && answers[id] === undefined && field.type === 'date' && field.config.defaultValue?.kind === 'today') {
      answers[id] = { type: 'date', value: today } as AnswerValue;
    }
  }
  /* A lookup fills only fields a person can edit: never a locked (legacy, auto-increment) field, nor the search field itself. */
  const locked = new Set(elements.filter((el) => isLegacyElement(el) || isIncrementElement(el)).map((el) => String(el.id)));
  const lookups = def.lookups?.flatMap((l) =>
    l.source !== 'dms_master' || locked.has(l.pickerFieldId) ? [] : [{ ...l, mappings: l.mappings.filter((m) => !locked.has(m.fieldId) && m.fieldId !== l.pickerFieldId) }],
  );
  /* The renderer works out "today" in the form's zone: make that the viewer's zone so its today is the seeded one. */
  def = {
    ...def,
    ...(lookups ? { lookups } : {}),
    blocks,
    behavior: { ...def.behavior, timeZone: clock.timeZone as FormDefinition['behavior']['timeZone'] },
    theme: { ...def.theme, tokens: { ...def.theme.tokens, density: 'compact', formWidth: 'wide' } },
  };
  const compiled = (() => {
    try {
      return compile(def, REGISTRY);
    } catch (e) {
      return { ok: false as const, issues: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  })();
  if (!compiled.ok) return { ok: false, message: compiled.issues.map((i) => i.message).slice(0, 3).join('; ') || 'The form could not be compiled.' };
  const stored: FormVersion = {
    id: 'fp-record' as FormVersionId,
    orgId: 'fp-record' as OrgId,
    formId: def.formId,
    number: 0,
    schemaVersion: def.schemaVersion,
    publishedAt: clock.now,
    publishedBy: 'fp-record' as UserId,
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
  return { ok: true, form: { version, initialAnswers: answers as Answers, baseline, blocks: byId, startedAt: clock.now } };
}
