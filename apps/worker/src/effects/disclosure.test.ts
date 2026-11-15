import { compile } from '@form/logic';
import { DEFAULT_COMPLIANCE, REGISTRY } from '@form/registry';
import type { CompiledForm, FieldCompliance, FormDefinition, ValueFieldType } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { disclosableFields, disclosedFieldKeys, formPurposeIds, MASK, type DisclosableFieldsInput } from './disclosure.ts';

/*
 * The purpose filter, the masking and the omission that every notification, webhook and export goes through. Definitions
 * here are built the way the builder stores them (registry defaults), and the taint cases use the real `compile`.
 */

const RESPOND = 'respond';
const MARKETING = 'marketing';
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });

interface Spec {
  id: string;
  type?: ValueFieldType;
  label?: string;
  /** Purpose ids are plain strings here; the definition is cast to the contract type once, in `definitionOf`. */
  compliance?: Partial<Omit<FieldCompliance, 'purposeIds'>> & { purposeIds?: string[] };
  config?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function field(spec: Spec) {
  const type = spec.type ?? 'short_text';
  const defaults = DEFAULT_COMPLIANCE[type];
  return {
    id: spec.id,
    type,
    key: spec.id,
    label: doc(spec.label ?? `Label of ${spec.id}`),
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' ? [] : [RESPOND], ...spec.compliance } as FieldCompliance,
    config: { ...REGISTRY[type].defaultConfig('en-IN' as never), ...spec.config },
    ...spec.extra,
  };
}

const personal = (id: string, compliance: Spec['compliance'] = {}, extra: Partial<Spec> = {}) =>
  field({ id, compliance: { classification: 'personal', purposeIds: [RESPOND], inNotifications: 'include', inExports: 'include', ...compliance }, ...extra });

/** A definition that `compile` accepts, with `blocks` placed on one page (the ids in `children` are reachable only through a group). */
function definitionOf(blocks: ReturnType<typeof field>[], onPage: readonly string[] = blocks.map((b) => b.id)): FormDefinition {
  const purpose = (id: string) => ({
    id,
    name: id,
    description: doc(id),
    lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: 'The respondent sent it' },
    retention: { kind: 'org_default' },
  });
  return {
    schemaVersion: 2,
    revision: 0,
    formId: 'form_1',
    title: 'Disclosure fixture',
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    pages: [{ id: 'page_1', children: [...onPage] }],
    endings: [{ id: 'end_1', kind: 'message', name: 'Thanks', content: { type: 'doc', content: [] }, actions: [] }],
    defaultEndingId: 'end_1',
    logic: { rules: [], ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: ['Acme'],
        contactEmail: ['privacy@acme.example'],
        privacyContact: { name: ['Priya'], email: ['privacy@acme.example'] },
        rightsUrl: ['https://acme.example/rights'],
        boardComplaintInfo: ['You may complain to the Data Protection Board of India.'],
      },
      purposes: [purpose(RESPOND), purpose(MARKETING)],
      children: { mode: 'not_applicable' },
      encryption: { mode: 'server' },
      dropAnswersWithoutConsent: true,
      networkSignals: { ipHash: true, userAgentHash: true, ttlDays: 30 },
    },
    theme: {
      layout: 'classic',
      tokens: { colors: {}, typography: { body: 'inter', baseSizePx: 16 }, radius: 'md', density: 'comfortable', formWidth: 'normal', labelAlign: 'top', inputStyle: 'outlined', progress: 'bar' },
    },
    behavior: {
      submit: { label: 'Submit', align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: 'Asia/Kolkata',
      spam: { honeypot: true, minFillSeconds: 0, captcha: 'off' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: false,
    },
    i18n: { defaultLocale: 'en-IN', locales: [{ locale: 'en-IN', direction: 'ltr' }], detect: ['url_param'], urlParam: 'lang', switcher: 'none', messages: {}, systemMessages: {}, reviewedConsentLocales: ['en-IN'] },
  } as unknown as FormDefinition;
}

const compiledOf = (def: FormDefinition): CompiledForm => {
  const result = compile(def, REGISTRY);
  if (!result.ok) throw new Error(`fixture does not compile: ${result.issues.map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
  return result.compiled;
};

const answered = (byBlock: Record<string, [type: string, value: unknown]>) => Object.fromEntries(Object.entries(byBlock).map(([id, [type, value]]) => [id, { type, value }]));

/** The standard case: one answer per field, `definition` compiled for real, asked as a notification for `respond` unless told otherwise. */
function ask(blocks: ReturnType<typeof field>[], answers: Record<string, [string, unknown]>, o: Partial<DisclosableFieldsInput> = {}) {
  const definition = definitionOf(blocks);
  return disclosableFields({ definition, compiled: compiledOf(definition), answers: answered(answers), purposeIds: [RESPOND], channel: 'notification', ...o });
}

const textsOf = (rows: ReturnType<typeof disclosableFields>) => Object.fromEntries(rows.map((r) => [r.key, r.text]));

describe('disclosableFields: masking and omission', () => {
  const blocks = [
    personal('name'),
    personal('pan', { classification: 'sensitive', encrypt: true, inNotifications: 'mask', inExports: 'mask' }),
    personal('ssn', { classification: 'sensitive', encrypt: true, inNotifications: 'omit', inExports: 'omit' }),
  ];
  const answers = { name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'], ssn: ['short_text', '123-45-6789'] } as Record<string, [string, unknown]>;

  it('renders MASK for a field set to mask and leaves out one set to omit, in notifications', () => {
    const rows = ask(blocks, answers);
    expect(textsOf(rows)).toEqual({ name: 'Asha', pan: MASK });
    expect(rows.map((r) => r.key)).toEqual(['name', 'pan']);
    const pan = rows.find((r) => r.key === 'pan')!;
    expect(pan).toMatchObject({ masked: true, answered: true, cells: [MASK] });
    expect(pan).not.toHaveProperty('value');
    expect(JSON.stringify(rows)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(rows)).not.toContain('123-45-6789');
  });

  it('applies sensitiveOverride only as stricter: omit turns mask into absent and never turns omit into shown', () => {
    const omit = ask(blocks, answers, { sensitiveOverride: 'omit' });
    expect(omit.map((r) => r.key)).toEqual(['name']);
    const mask = ask(blocks, answers, { sensitiveOverride: 'mask' });
    // 'mask' leaves an omitted field omitted, a masked field masked, and a plain personal field as it was.
    expect(textsOf(mask)).toEqual({ name: 'Asha', pan: MASK });
    expect(ask(blocks, answers, {}).map((r) => r.key)).toEqual(['name', 'pan']);
  });

  it('lets sensitiveOverride mask a sensitive field whose own setting says include, but not a plain one', () => {
    const open = [personal('name'), personal('pan', { classification: 'sensitive', encrypt: true, inNotifications: 'include' })];
    const a = { name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'] } as Record<string, [string, unknown]>;
    expect(textsOf(ask(open, a))).toEqual({ name: 'Asha', pan: 'ABCDE1234F' });
    expect(textsOf(ask(open, a, { sensitiveOverride: 'mask' }))).toEqual({ name: 'Asha', pan: MASK });
    expect(Object.keys(textsOf(ask(open, a, { sensitiveOverride: 'omit' })))).toEqual(['name']);
  });

  it('follows inNotifications for notifications and webhooks, and inExports for exports', () => {
    const split = [personal('a', { inNotifications: 'omit', inExports: 'include' }), personal('b', { inNotifications: 'include', inExports: 'omit' }), personal('c', { inNotifications: 'mask', inExports: 'include' })];
    const a = { a: ['short_text', 'one'], b: ['short_text', 'two'], c: ['short_text', 'three'] } as Record<string, [string, unknown]>;
    expect(textsOf(ask(split, a, { channel: 'notification' }))).toEqual({ b: 'two', c: MASK });
    expect(textsOf(ask(split, a, { channel: 'webhook' }))).toEqual({ b: 'two', c: MASK });
    expect(textsOf(ask(split, a, { channel: 'export' }))).toEqual({ a: 'one', c: 'three' });
  });
});

describe('disclosableFields: purposes', () => {
  const blocks = [
    personal('name', { purposeIds: [RESPOND] }),
    personal('phone', { purposeIds: [MARKETING] }),
    field({ id: 'seats', type: 'number' }),
  ];
  const answers = { name: ['short_text', 'Asha'], phone: ['short_text', '9876543210'], seats: ['number', '3'] } as Record<string, [string, unknown]>;

  it('leaves out a personal field outside the purposes, keeps one of an included purpose, and keeps a classification-none field with no purposes', () => {
    const rows = ask(blocks, answers, { purposeIds: [RESPOND] });
    expect(textsOf(rows)).toEqual({ name: 'Asha', seats: '3' });
    expect(textsOf(ask(blocks, answers, { purposeIds: [MARKETING] }))).toEqual({ phone: '9876543210', seats: '3' });
    expect(textsOf(ask(blocks, answers, { purposeIds: [RESPOND, MARKETING] }))).toEqual({ name: 'Asha', phone: '9876543210', seats: '3' });
    expect(blocks[2]!.compliance).toMatchObject({ classification: 'none', purposeIds: [] });
  });

  it('sends only the non-personal fields to a recipient with no purpose, and fails closed for a personal field with none declared', () => {
    expect(textsOf(ask(blocks, answers, { purposeIds: [] }))).toEqual({ seats: '3' });
    const undeclared = [personal('orphan', { purposeIds: [] }), field({ id: 'seats', type: 'number' })];
    expect(textsOf(ask(undeclared, { orphan: ['short_text', 'x'], seats: ['number', '3'] }, { purposeIds: [RESPOND] }))).toEqual({ seats: '3' });
  });

  it('treats a classification-none field that names a purpose as bound to it', () => {
    const tied = [field({ id: 'note', compliance: { classification: 'none', purposeIds: [MARKETING] } })];
    expect(ask(tied, { note: ['short_text', 'x'] }, { purposeIds: [RESPOND] })).toEqual([]);
    expect(textsOf(ask(tied, { note: ['short_text', 'x'] }, { purposeIds: [MARKETING] }))).toEqual({ note: 'x' });
  });

  it('applies fieldKeys on top of the purposes, never beyond them', () => {
    const rows = ask(blocks, answers, { purposeIds: [RESPOND], fieldKeys: ['phone', 'seats'] });
    expect(textsOf(rows)).toEqual({ seats: '3' });
    expect(ask(blocks, answers, { purposeIds: [RESPOND], fieldKeys: [] })).toEqual([]);
  });

  it('exposes every purpose of the form for an export', () => {
    expect(formPurposeIds(definitionOf(blocks))).toEqual([RESPOND, MARKETING]);
  });
});

describe('disclosableFields: taint', () => {
  /** `copy` is a hidden field that captures `pan`, so the compiler taints it `sensitive` even though its own setting says include. */
  const pan = personal('pan', { classification: 'sensitive', encrypt: true, inNotifications: 'mask', inExports: 'mask' });
  const copy = field({
    id: 'copy',
    type: 'hidden',
    compliance: { classification: 'none', purposeIds: [], inNotifications: 'include', inExports: 'include' },
    config: { source: { kind: 'expr', expr: { k: 'ref', ref: { kind: 'answer', blockId: 'pan' } } } },
  });
  const answers = { pan: ['short_text', 'ABCDE1234F'], copy: ['hidden', 'ABCDE1234F'] } as Record<string, [string, unknown]>;

  it('masks a value derived from a sensitive field (compiled.taint) even when its own setting says include', () => {
    const definition = definitionOf([pan, copy]);
    const compiled = compiledOf(definition);
    expect(compiled.taint['value:copy']).toMatchObject({ classification: 'sensitive' });
    expect(copy.compliance).toMatchObject({ classification: 'none', inNotifications: 'include' });
    const rows = disclosableFields({ definition, compiled, answers: answered(answers), purposeIds: [RESPOND], channel: 'notification' });
    expect(textsOf(rows)).toEqual({ pan: MASK, copy: MASK });
    expect(JSON.stringify(rows)).not.toContain('ABCDE1234F');
    // Without the taint the same field would have shown: the mask is the taint's doing.
    const untainted = disclosableFields({ definition, compiled: { taint: {} }, answers: answered(answers), purposeIds: [RESPOND], channel: 'notification' });
    expect(textsOf(untainted)).toEqual({ pan: MASK, copy: 'ABCDE1234F' });
  });

  it('puts the purposes of a taint into the filter: a derived value goes only to recipients of the purposes it was derived from', () => {
    const definition = definitionOf([pan, copy]);
    const compiled = compiledOf(definition);
    const rows = disclosableFields({ definition, compiled, answers: answered(answers), purposeIds: [MARKETING], channel: 'notification' });
    expect(rows).toEqual([]);
  });

  it('shows what is masked, by taint or by setting, in an export with includeSensitive, and still omits what is omitted', () => {
    const ssn = personal('ssn', { classification: 'sensitive', encrypt: true, inNotifications: 'omit', inExports: 'omit' });
    const definition = definitionOf([pan, copy, ssn]);
    const compiled = compiledOf(definition);
    const input = { definition, compiled, answers: answered({ ...answers, ssn: ['short_text', '123-45-6789'] }), purposeIds: [RESPOND] };
    expect(textsOf(disclosableFields({ ...input, channel: 'export' }))).toEqual({ pan: MASK, copy: MASK });
    const sensitive = disclosableFields({ ...input, channel: 'export', includeSensitive: true });
    expect(textsOf(sensitive)).toEqual({ pan: 'ABCDE1234F', copy: 'ABCDE1234F' });
    expect(sensitive.every((r) => !r.masked)).toBe(true);
    // includeSensitive is for exports: a notification or a webhook asking for it gets the masks all the same.
    for (const channel of ['notification', 'webhook'] as const) {
      expect(textsOf(disclosableFields({ ...input, channel, includeSensitive: true }))).toEqual({ pan: MASK, copy: MASK });
    }
  });
});

describe('disclosableFields: rows', () => {
  it('lists fields in document order with their key, label, type, text and cells, and the stored value when it is shown', () => {
    const blocks = [personal('first', {}, { label: 'First name' }), field({ id: 'seats', type: 'number', label: 'Seats' }), personal('last')];
    const rows = ask(blocks, { last: ['short_text', 'Rao'], first: ['short_text', 'Asha'], seats: ['number', '3'] });
    expect(rows).toEqual([
      { blockId: 'first', key: 'first', label: 'First name', type: 'short_text', text: 'Asha', cells: ['Asha'], masked: false, answered: true, value: 'Asha' },
      { blockId: 'seats', key: 'seats', label: 'Seats', type: 'number', text: '3', cells: ['3'], masked: false, answered: true, value: '3' },
      { blockId: 'last', key: 'last', label: 'Label of last', type: 'short_text', text: 'Rao', cells: ['Rao'], masked: false, answered: true, value: 'Rao' },
    ]);
  });

  it('lists an allowed field with no answer, or a blank one, as unanswered with empty text, so a table can show it blank', () => {
    const rows = ask([personal('first'), personal('last'), personal('blank')], { first: ['short_text', 'Asha'], blank: ['short_text', ''] });
    expect(rows.map((r) => [r.key, r.text, r.answered, r.masked])).toEqual([
      ['first', 'Asha', true, false],
      ['last', '', false, false],
      ['blank', '', false, false],
    ]);
  });

  it('never lists an unanswered field that is out of purpose or omitted (its label would say it exists)', () => {
    const rows = ask([personal('hidden_one', { inNotifications: 'omit' }), personal('other', { purposeIds: [MARKETING] })], {});
    expect(rows).toEqual([]);
  });

  it('masks an answer it cannot read: a sealed one, or one whose type is not the field’s, even with includeSensitive', () => {
    const blocks = [personal('sealed'), personal('odd')];
    const answers = {
      sealed: { type: 'short_text', enc: { alg: 'A256GCM', kid: 'k1', iv: 'aXY', ct: 'Y3Q', aad: 'a:b' } },
      odd: { type: 'number', value: '7' },
    };
    const definition = definitionOf(blocks);
    const input = { definition, compiled: compiledOf(definition), answers, purposeIds: [RESPOND] };
    for (const o of [{ channel: 'notification' as const }, { channel: 'export' as const, includeSensitive: true }]) {
      const rows = disclosableFields({ ...input, ...o });
      expect(rows.map((r) => [r.key, r.text, r.masked, r.answered])).toEqual([
        ['sealed', MASK, true, true],
        ['odd', MASK, true, true],
      ]);
    }
  });

  it('gives a masked field one MASK cell per export column, so a row lines up with its header', () => {
    const full = field({ id: 'who', type: 'full_name', compliance: { inExports: 'mask' } });
    const definition = definitionOf([full]);
    const columns = REGISTRY.full_name.export.columns(full as never).length;
    expect(columns).toBeGreaterThan(1);
    const input = { definition, compiled: compiledOf(definition), answers: answered({ who: ['full_name', { first: 'Asha', last: 'Rao' }] }), purposeIds: [RESPOND], channel: 'export' as const };
    const [row] = disclosableFields(input);
    expect(row!.cells).toEqual(Array.from({ length: columns }, () => MASK));
    const [shown] = disclosableFields({ ...input, includeSensitive: true });
    expect(shown!.cells).toHaveLength(columns);
    expect(shown!.cells.join(' ')).toContain('Asha');
  });

  it('keeps a repeating group as strict as its strictest child: shown whole, or masked, never in part', () => {
    const group = (children: string[]) =>
      field({ id: 'people', type: 'repeating_group', compliance: { classification: 'none', purposeIds: [], inNotifications: 'include', inExports: 'include' }, config: { children, minRows: 0, maxRows: 5, initialRows: 1, layout: 'stacked' } });
    const rowsValue = { rows: [{ rowId: 'row_1', values: { who: { type: 'short_text', value: 'Asha' }, secret: { type: 'short_text', value: 'ABCDE1234F' } } }] };
    const plain = [personal('who'), personal('secret')];
    const ok = disclosableFields({ ...inputFor([group(['who', 'secret']), ...plain], ['people']), answers: { people: { type: 'repeating_group', value: rowsValue } } });
    expect(ok.find((r) => r.key === 'people')).toMatchObject({ masked: false });
    const guarded = [group(['who', 'secret']), personal('who'), personal('secret', { classification: 'sensitive', encrypt: true, inNotifications: 'mask' })];
    const masked = disclosableFields({ ...inputFor(guarded, ['people']), answers: { people: { type: 'repeating_group', value: rowsValue } } });
    expect(masked.find((r) => r.key === 'people')).toMatchObject({ masked: true, text: MASK });
    expect(JSON.stringify(masked)).not.toContain('ABCDE1234F');
    const omitted = [group(['who', 'secret']), personal('who'), personal('secret', { inNotifications: 'omit' })];
    expect(disclosableFields({ ...inputFor(omitted, ['people']), answers: { people: { type: 'repeating_group', value: rowsValue } } }).find((r) => r.key === 'people')).toMatchObject({ masked: true });
    // An export with includeSensitive shows the group once its masked child is shown.
    const lifted = disclosableFields({ ...inputFor(guarded, ['people']), channel: 'export', includeSensitive: true, answers: { people: { type: 'repeating_group', value: rowsValue } } });
    expect(lifted.find((r) => r.key === 'people')).toMatchObject({ masked: false });
  });
});

function inputFor(blocks: ReturnType<typeof field>[], onPage: readonly string[]): DisclosableFieldsInput {
  const definition = definitionOf(blocks, onPage);
  return { definition, compiled: { taint: {} }, answers: {}, purposeIds: [RESPOND], channel: 'notification' };
}

describe('disclosedFieldKeys', () => {
  it('names the fields whose value was sent: not the masked, not the blank, unless asked', () => {
    const blocks = [personal('a'), personal('b', { inNotifications: 'mask' }), personal('c')];
    const rows = ask(blocks, { a: ['short_text', 'x'], b: ['short_text', 'y'] });
    expect(disclosedFieldKeys(rows)).toEqual(['a']);
    expect(disclosedFieldKeys(rows, { includeMasked: true })).toEqual(['a', 'b']);
  });
});
