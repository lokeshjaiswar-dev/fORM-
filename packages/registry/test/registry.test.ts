import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES, FieldComplianceSchema, VALUE_FIELD_TYPES, type BlockId, type BlockType, type OptionId, type Rule, type ValueFieldType,
} from '@form/schema';
import {
  AVAILABLE_TYPES, COMPLIANCE_UNDER_REVIEW, DEFAULT_COMPLIANCE, DRAFT_DEFAULT_CONFIG_TYPES, REGISTRY, STUB_AVAILABILITY, UNBOUND_BLOCK_ID, answerScalar, availability,
  bindScalar, isAvailable, isBlank, valueDefinition, wordCount,
} from '../src/index.ts';
import { EN_IN, definition, fieldBlock, file, id, inline, plainBlock } from './fixtures.ts';

const VALUE_TYPES: ReadonlySet<string> = new Set(VALUE_FIELD_TYPES);
const STUB_TYPES = BLOCK_TYPES.filter((t) => !isAvailable(t));

describe('REGISTRY', () => {
  it('has exactly one entry per BlockType, keyed by its own type', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([...BLOCK_TYPES].sort());
    for (const type of BLOCK_TYPES) expect(REGISTRY[type].type).toBe(type);
  });

  it('gives value types answer members and every other block none', () => {
    for (const type of BLOCK_TYPES) {
      const def = REGISTRY[type];
      if (VALUE_TYPES.has(type)) {
        expect(['input', 'computed']).toContain(def.kind);
        expect(def.defaultCompliance).not.toBeNull();
        expect(typeof def.answerSchema).toBe('function');
        expect(def.export).not.toBeNull();
      } else {
        expect(['transient', 'content', 'container']).toContain(def.kind);
        expect([def.defaultCompliance, def.answerSchema, def.toScalar, def.isEmpty, def.export]).toEqual([null, null, null, null, null]);
        expect(def.paths).toEqual({});
      }
    }
  });

  it('lists a palette for available types only, with unique ids', () => {
    const ids = BLOCK_TYPES.flatMap((t) => REGISTRY[t].palette.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const type of BLOCK_TYPES) expect(REGISTRY[type].palette.length > 0).toBe(isAvailable(type));
  });

  it('every default config of an available type parses with its config schema', () => {
    for (const type of AVAILABLE_TYPES) expect(REGISTRY[type].configSchema.safeParse(REGISTRY[type].defaultConfig(EN_IN)).success, type).toBe(true);
  });

  it('derives locale defaults from the region', () => {
    expect(REGISTRY.phone.defaultConfig(id('en-US'))).toMatchObject({ defaultCountry: 'US' });
    expect(REGISTRY.phone.defaultConfig(id('hi'))).toMatchObject({ defaultCountry: 'IN' });
    expect(REGISTRY.date.defaultConfig(id('en-US'))).toMatchObject({ pattern: 'MM/DD/YYYY' });
    expect(REGISTRY.date.defaultConfig(EN_IN)).toMatchObject({ pattern: 'DD-MM-YYYY' });
    expect(REGISTRY.time.defaultConfig(id('de-DE'))).toMatchObject({ hourCycle: 'h23' });
    expect(REGISTRY.single_choice.defaultConfig(EN_IN).options.map((o) => o.label)).toEqual(['Option 1', 'Option 2', 'Option 3']);
  });
});

describe('availability', () => {
  it('marks the 20 P0 types available and every other type P1 or P2', () => {
    expect(AVAILABLE_TYPES).toHaveLength(20);
    for (const type of AVAILABLE_TYPES) expect(availability(type)).toBe('P0');
    for (const type of STUB_TYPES) expect(['P1', 'P2']).toContain(availability(type));
    expect(Object.keys(STUB_AVAILABILITY).sort()).toEqual([...STUB_TYPES].sort());
    expect(isAvailable('unsupported')).toBe(false);
  });
});

describe('stubs', () => {
  it.each(STUB_TYPES)('%s: real config schema, no palette, refused by compile', (type) => {
    const def = REGISTRY[type];
    expect(def.capability).toBeDefined();
    expect(def.palette).toEqual([]);
    expect(def.operators).toEqual({});
    const parsed = def.configSchema.safeParse(def.defaultConfig(EN_IN));
    expect(parsed.success).toBe(!(DRAFT_DEFAULT_CONFIG_TYPES as readonly string[]).includes(type));
    expect(def.configSchema.safeParse({ nonsense: true }).success).toBe(false);
    const block = { id: id<BlockId>(`${type}_1`) };
    expect(def.lint(block as never, definition([]))).toEqual([
      expect.objectContaining({ severity: 'error', code: 'missing_capability', path: `/blocks/${type}_1` }),
    ]);
    expect(def.lockableContent(block as never)).toContain('/config');
  });

  it('repeating_group starts without children until the builder inserts one', () => {
    expect(DRAFT_DEFAULT_CONFIG_TYPES).toEqual(['repeating_group']);
    expect(REGISTRY.repeating_group.defaultConfig(EN_IN)).toMatchObject({ children: [] });
    expect(REGISTRY.repeating_group.configSchema.safeParse({ ...REGISTRY.repeating_group.defaultConfig(EN_IN), children: ['short_text_1'] }).success).toBe(true);
  });

  it('value stubs parse answers with the twin and export canonical JSON', () => {
    const def = valueDefinition('full_name');
    const block = fieldBlock('full_name');
    const schema = def.answerSchema(block, { required: true });
    expect(schema.safeParse({ first: 'Asha', last: 'Rao' })).toEqual({ success: true, data: { first: 'Asha', last: 'Rao' } });
    expect(schema.safeParse({}).success).toBe(false);
    expect(def.toScalar({ first: 'Asha' })).toEqual({ t: 'null' });
    expect(def.isEmpty({})).toBe(true);
    expect(def.isEmpty({ first: 'Asha' })).toBe(false);
    expect(def.export.columns(block)).toEqual([{ suffix: '', header: 'My full name' }]);
    expect(def.export.cells({ last: 'Rao', first: 'Asha' }, block)).toEqual(['{"first":"Asha","last":"Rao"}']);
    expect(def.export.text({ first: 'Asha' }, block)).toBe('{"first":"Asha"}');
    expect(def.translatable(block)).toEqual(['block:full_name_1:label']);
    expect(valueDefinition('calculation').kind).toBe('computed');
    expect(REGISTRY.captcha.translatable(plainBlockStub('captcha'))).toEqual([]);
  });

  it('stub isEmpty agrees with I9: true exactly for the values the twin rejects as unanswered (BL-062)', () => {
    const notice = { noticeLocale: 'en-IN', noticeVersion: 1 };
    const samples: Partial<Record<ValueFieldType, { valid: unknown[]; empty: unknown[] }>> = {
      full_name: { valid: [{ first: 'Asha' }], empty: [{}, { first: '' }] },
      address: { valid: [{ city: 'Pune' }], empty: [{}, { line1: '', city: '' }] },
      matrix: {
        valid: [{ mode: 'single', rows: { r1: 'c1' } }, { mode: 'multi', rows: { r1: ['c1'] } }, { mode: 'grid', rows: { r1: { c1: true } } }],
        empty: [{ mode: 'single', rows: {} }, { mode: 'multi', rows: { r1: [] } }, { mode: 'grid', rows: { r1: {} } }, { mode: 'grid', rows: { r1: { c1: '' } } }],
      },
      repeating_group: { valid: [{ rows: [{ rowId: 'row_1', values: {} }] }], empty: [{ rows: [] }] },
      consent: { valid: [{ items: { item_1: true }, ...notice }, { items: { item_1: false }, ...notice }], empty: [{ items: {}, ...notice }] },
      payment: {
        valid: [{ currency: 'INR', customAmount: '100' }, { currency: 'INR', items: [{ productId: 'p1', quantity: 1 }] }],
        empty: [{ currency: 'INR' }, { currency: 'INR', items: [] }],
      },
      context: { valid: ['https://example.com'], empty: [''] },
      unique_id: { valid: ['F-000001'], empty: [''] },
    };
    for (const [type, { valid, empty }] of Object.entries(samples) as Array<[ValueFieldType, { valid: unknown[]; empty: unknown[] }]>) {
      const def = valueDefinition(type);
      const isEmpty = def.isEmpty as (value: unknown) => boolean;
      const schema = def.answerSchema(fieldBlock(type) as never, { required: false });
      for (const value of valid) {
        expect(isEmpty(value), `${type} ${JSON.stringify(value)}`).toBe(false);
        expect(schema.safeParse(value).success, `${type} ${JSON.stringify(value)}`).toBe(true);
      }
      for (const value of empty) {
        expect(isEmpty(value), `${type} ${JSON.stringify(value)}`).toBe(true);
        expect(schema.safeParse(value).success, `${type} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it('counts words with the pinned White_Space set, not the host \\s (BL-047)', () => {
    const cp = (...points: number[]) => String.fromCharCode(...points);
    expect(wordCount('')).toBe(0);
    expect(wordCount(' one  two\tthree\n')).toBe(3);
    expect(wordCount(`one${cp(0xa0)}two${cp(0x3000)}three${cp(0x2009)}four`)).toBe(4);
    expect(wordCount(`one${cp(0x180e)}two`)).toBe(1);
    expect(wordCount(`one${cp(0xfeff)}two`)).toBe(1);
    expect(wordCount('नमस्ते दुनिया')).toBe(2);
  });

  it('isBlank follows I9 for any shape', () => {
    expect([undefined, null, '', [], {}, { a: '', b: [] }].every(isBlank)).toBe(true);
    expect([0, false, 'x', ['x'], { a: 'x' }].some(isBlank)).toBe(false);
  });
});

const plainBlockStub = (type: 'captcha') => ({ id: id<BlockId>(`${type}_1`), type, config: { provider: 'platform_default' as const } });

describe('default compliance (CMP-03)', () => {
  it('parses for every value type and starts without purposes', () => {
    for (const type of VALUE_FIELD_TYPES) {
      expect(FieldComplianceSchema.safeParse(DEFAULT_COMPLIANCE[type]).success, type).toBe(true);
      expect(REGISTRY[type].defaultCompliance).toBe(DEFAULT_COMPLIANCE[type]);
      expect(DEFAULT_COMPLIANCE[type].purposeIds).toEqual([]);
    }
  });

  it('matches the WP-0.06 defaults', () => {
    const pick = (t: ValueFieldType) => {
      const { classification, category, principalIdentifier } = DEFAULT_COMPLIANCE[t];
      return { classification, category, principalIdentifier };
    };
    expect(pick('email')).toEqual({ classification: 'personal', category: 'contact', principalIdentifier: 'email' });
    expect(pick('phone')).toEqual({ classification: 'personal', category: 'contact', principalIdentifier: undefined });
    expect(pick('signature')).toEqual({ classification: 'personal', category: 'identity', principalIdentifier: undefined });
    expect(pick('short_text')).toMatchObject({ classification: 'personal', category: 'free_text' });
    expect(pick('long_text')).toMatchObject({ classification: 'personal', category: 'free_text' });
    expect(pick('hidden')).toMatchObject({ classification: 'none' });
    expect(COMPLIANCE_UNDER_REVIEW).toEqual(['hidden']);
  });

  it('is frozen so a block never shares mutable defaults', () => {
    expect(Object.isFrozen(DEFAULT_COMPLIANCE.email)).toBe(true);
    expect(Object.isFrozen(DEFAULT_COMPLIANCE.email.purposeIds)).toBe(true);
  });
});

const VALUE_AVAILABLE = AVAILABLE_TYPES.filter((t): t is Extract<typeof t, ValueFieldType> => VALUE_TYPES.has(t));

describe('operator matrix', () => {
  it('matches the snapshot', () => {
    const matrix = Object.fromEntries(VALUE_AVAILABLE.map((t) => [t, { paths: REGISTRY[t].paths, operators: REGISTRY[t].operators }]));
    expect(matrix).toMatchSnapshot();
  });

  it('never offers ordering on choices or text, nor text matching on numbers', () => {
    for (const type of VALUE_AVAILABLE) {
      const { operators } = REGISTRY[type];
      for (const op of ['gt', 'lt', 'between'] as const) {
        expect(operators.choice ?? []).not.toContain(op);
        expect(operators.choices ?? []).not.toContain(op);
        expect(operators.text ?? []).not.toContain(op);
      }
      expect(operators.number ?? []).not.toContain('contains');
    }
  });
});

describe('export headers', () => {
  it('match the snapshot', () => {
    const headers = Object.fromEntries(VALUE_AVAILABLE.map((t) => [t, REGISTRY[t].export.columns(fieldBlock(t) as never)]));
    headers['single_choice+other'] = REGISTRY.single_choice.export.columns(fieldBlock('single_choice', { other: { enabled: true, textRequired: true } }));
    headers['multi_choice+other'] = REGISTRY.multi_choice.export.columns(fieldBlock('multi_choice', { other: { enabled: true, label: 'Something else', textRequired: true } }));
    headers['time+range'] = REGISTRY.time.export.columns(fieldBlock('time', { range: { enabled: true } }));
    headers['ranking+top2'] = REGISTRY.ranking.export.columns(fieldBlock('ranking', { rankTop: 2 }));
    headers['blank label'] = REGISTRY.short_text.export.columns(fieldBlock('short_text', {}, { label: inline('  ') }));
    expect(headers).toMatchSnapshot();
  });

  it('writes option labels (or codes when an id is stale) and other text', () => {
    const block = fieldBlock('multi_choice', { other: { enabled: true, textRequired: true } });
    const value = { optionIds: [id<OptionId>('option_2'), id<OptionId>('gone')], other: 'Mine' };
    expect(REGISTRY.multi_choice.export.cells(value, block)).toEqual(['Option 2; gone', 'Mine']);
    expect(REGISTRY.multi_choice.export.text(value, block)).toBe('Option 2; gone; Mine');
    const single = fieldBlock('single_choice', { other: { enabled: true, textRequired: true } });
    expect(REGISTRY.single_choice.export.cells({ optionId: null, other: 'Mine' }, single)).toEqual(['', 'Mine']);
    expect(REGISTRY.single_choice.export.text({ optionId: id<OptionId>('option_1') }, single)).toBe('Option 1');
    expect(REGISTRY.single_choice.export.text({ optionId: null, other: 'Mine' }, single)).toBe('Mine');
    const ranking = fieldBlock('ranking');
    expect(REGISTRY.ranking.export.cells([id<OptionId>('option_3')], ranking)).toEqual(['Option 3', '', '']);
    expect(REGISTRY.ranking.export.text([id<OptionId>('option_3'), id<OptionId>('option_1')], ranking)).toBe('Option 3 > Option 1');
    expect(REGISTRY.time.export.text({ start: id('09:00'), end: id('10:00') }, fieldBlock('time'))).toBe('09:00–10:00');
    expect(REGISTRY.signature.export.cells({ method: 'typed', typedName: 'Asha', file: file('s.png', 'image/png') }, fieldBlock('signature'))).toEqual(['Asha']);
    expect(REGISTRY.file_upload.export.cells([file('a.pdf', 'application/pdf'), file('b.png', 'image/png')], fieldBlock('file_upload'))).toEqual(['a.pdf; b.png']);
  });
});

describe('toScalar', () => {
  it('reads composite paths', () => {
    expect(REGISTRY.phone.toScalar({ e164: '+919812345678', country: id('IN') }, 'country')).toEqual({ t: 'text', v: 'IN' });
    expect(REGISTRY.phone.toScalar({ e164: '+919812345678', country: id('IN') })).toEqual({ t: 'text', v: '+919812345678' });
    expect(REGISTRY.multi_choice.toScalar({ optionIds: [id('a')], other: 'x' }, 'count')).toEqual({ t: 'number', v: '2' });
    expect(REGISTRY.multi_choice.toScalar({ optionIds: [id('a')] }, 'other')).toEqual({ t: 'null' });
    expect(REGISTRY.single_choice.toScalar({ optionId: null, other: 'x' })).toEqual({ t: 'null' });
    expect(REGISTRY.single_choice.toScalar({ optionId: null, other: 'x' }, 'other')).toEqual({ t: 'text', v: 'x' });
    expect(REGISTRY.time.toScalar({ start: id('09:00') }, 'end')).toEqual({ t: 'null' });
    expect(REGISTRY.time.toScalar({ start: id('09:00'), end: id('10:00') }, 'end')).toEqual({ t: 'time', v: '10:00' });
    expect(REGISTRY.file_upload.toScalar([file('a.pdf', 'application/pdf')], 'count')).toEqual({ t: 'number', v: '1' });
    expect(REGISTRY.rating.toScalar(4)).toEqual({ t: 'number', v: '4' });
    expect(REGISTRY.signature.toScalar({ method: 'drawn', file: file('s.png', 'image/png') })).toEqual({ t: 'boolean', v: true });
  });

  it('leaves option scalars unbound until bound to their block', () => {
    const scalar = REGISTRY.single_choice.toScalar({ optionId: id('option_1') });
    expect(scalar).toEqual({ t: 'option', blockId: UNBOUND_BLOCK_ID, v: 'option_1' });
    const block = fieldBlock('multi_choice');
    expect(answerScalar(block, { optionIds: [id('option_1'), id('option_2')] })).toEqual({
      t: 'list', of: 'option', items: [{ t: 'option', blockId: block.id, v: 'option_1' }, { t: 'option', blockId: block.id, v: 'option_2' }],
    });
    expect(bindScalar({ t: 'text', v: 'x' }, block.id)).toEqual({ t: 'text', v: 'x' });
    expect(answerScalar(fieldBlock('ranking'), [id<OptionId>('option_2')])).toMatchObject({ items: [{ blockId: 'ranking_1' }] });
  });
});

describe('translatable and lockable content', () => {
  it('lists label, description, messages, config texts and options', () => {
    const block = fieldBlock('single_choice', {
      placeholder: 'Pick one',
      other: { enabled: true, label: 'Something else', placeholder: '  ', textRequired: true },
    }, { description: { type: 'doc', content: [] }, messages: { required: 'Please choose' } });
    expect(REGISTRY.single_choice.translatable(block)).toEqual([
      'block:single_choice_1:label', 'block:single_choice_1:description', 'block:single_choice_1:msg:required',
      'option:single_choice_1/option_1', 'option:single_choice_1/option_2', 'option:single_choice_1/option_3',
      'block:single_choice_1:otherLabel', 'block:single_choice_1:placeholder',
    ]);
    expect(REGISTRY.single_choice.lockableContent(block)).toEqual(['/label', '/description', '/config/options', '/config/other']);
    expect(REGISTRY.short_text.translatable(fieldBlock('short_text', { placeholder: 'Your name', prefix: '' }))).toEqual([
      'block:short_text_1:label', 'block:short_text_1:placeholder',
    ]);
    expect(REGISTRY.rating.translatable(fieldBlock('rating', { lowLabel: 'Bad', highLabel: 'Great' }))).toEqual([
      'block:rating_1:label', 'block:rating_1:lowLabel', 'block:rating_1:highLabel',
    ]);
    expect(REGISTRY.signature.translatable(fieldBlock('signature', { statement: inline('I confirm') }))).toContain('block:signature_1:statement');
    expect(REGISTRY.signature.lockableContent(fieldBlock('signature', { statement: inline('I confirm') }))).toEqual(['/label', '/config/statement']);
    expect(REGISTRY.ranking.lockableContent(fieldBlock('ranking'))).toEqual(['/label', '/config/options']);
  });

  it('covers content blocks', () => {
    expect(REGISTRY.heading.translatable(plainBlock('heading', { subheading: inline('Sub') }))).toEqual(['block:heading_1:text', 'block:heading_1:subheading']);
    expect(REGISTRY.heading.lockableContent(plainBlock('heading'))).toEqual(['/config/text']);
    expect(REGISTRY.heading.lockableContent(plainBlock('heading', { subheading: inline('Sub') }))).toEqual(['/config/text', '/config/subheading']);
    expect(REGISTRY.paragraph.translatable(plainBlock('paragraph'))).toEqual(['block:paragraph_1:content']);
    expect(REGISTRY.paragraph.lockableContent(plainBlock('paragraph'))).toEqual(['/config/content']);
    expect(REGISTRY.divider.translatable(plainBlock('divider'))).toEqual([]);
    expect(REGISTRY.divider.lockableContent(plainBlock('divider'))).toEqual([]);
    expect(REGISTRY.heading.palette.map((p) => p.configOverrides)).toEqual([{ level: 1 }, { level: 2 }, { level: 3 }]);
    for (const type of ['heading', 'paragraph', 'divider'] as const) expect(REGISTRY[type].lint(plainBlock(type) as never, definition([]))).toEqual([]);
  });
});

describe('fixes', () => {
  it('B25: one answer shape per choice type, whatever the display', () => {
    for (const display of ['radio', 'dropdown', 'image'] as const) {
      const schema = REGISTRY.single_choice.answerSchema(fieldBlock('single_choice', { display }), { required: true });
      expect(schema.safeParse({ optionId: 'option_1' }).success).toBe(true);
      expect(schema.safeParse('option_1').success).toBe(false);
    }
    for (const display of ['checkbox', 'dropdown', 'image'] as const) {
      const schema = REGISTRY.multi_choice.answerSchema(fieldBlock('multi_choice', { display }), { required: true });
      expect(schema.safeParse({ optionIds: ['option_1'] }).success).toBe(true);
      expect(schema.safeParse(['option_1']).success).toBe(false);
    }
  });

  it('B7: NPS and linear scale have no default; 0 is a real NPS answer', () => {
    expect(REGISTRY.nps.defaultConfig(EN_IN)).toEqual({});
    expect(REGISTRY.linear_scale.defaultConfig(EN_IN)).not.toHaveProperty('defaultValue');
    expect(REGISTRY.nps.isEmpty(0)).toBe(false);
    expect(REGISTRY.nps.answerSchema(fieldBlock('nps'), { required: true }).safeParse(0).success).toBe(true);
    expect(REGISTRY.linear_scale.answerSchema(fieldBlock('linear_scale', { min: 0 }), { required: true }).safeParse(0).success).toBe(true);
  });

  it('B8: a ranking is absent until the respondent ranks, and a required one must be complete', () => {
    expect(REGISTRY.ranking.defaultConfig(EN_IN)).not.toHaveProperty('defaultValue');
    expect(REGISTRY.ranking.isEmpty([])).toBe(true);
    const block = fieldBlock('ranking');
    expect(REGISTRY.ranking.answerSchema(block, { required: true }).safeParse(['option_1']).success).toBe(false);
    expect(REGISTRY.ranking.answerSchema(block, { required: false }).safeParse(['option_1']).success).toBe(true);
    const top2 = fieldBlock('ranking', { rankTop: 2 });
    expect(REGISTRY.ranking.answerSchema(top2, { required: true }).safeParse(['option_3', 'option_1']).success).toBe(true);
  });

  it('B28: rating max is 1–10', () => {
    expect(REGISTRY.rating.configSchema.safeParse({ max: 10, icon: 'star' }).success).toBe(true);
    expect(REGISTRY.rating.configSchema.safeParse({ max: 1e7, icon: 'star' }).success).toBe(false);
  });
});

describe('lint', () => {
  const rule = (target: string): Rule => ({
    id: id('rule_1'),
    enabled: true,
    when: { kind: 'group', id: id('g_1'), combinator: 'all', children: [] },
    then: [{ type: 'show', targets: [id(target)] }],
    else: [{ type: 'set_value', target: id(target), value: { k: 'lit', value: { type: 'text', value: 'x' } } }],
  });
  const codes = (type: BlockType & ValueFieldType, block: ReturnType<typeof fieldBlock>, rules: Rule[] = []) =>
    REGISTRY[type].lint(block as never, definition([block as never], rules)).map((i) => i.code);

  it('B27: required + initially disabled is an error', () => {
    expect(codes('short_text', fieldBlock('short_text', {}, { required: true, initiallyDisabled: true }))).toEqual(['required_and_disabled']);
    expect(codes('short_text', fieldBlock('short_text', {}, { required: false, initiallyDisabled: true }))).toEqual([]);
  });

  it('B27: a required field that a rule enables may start disabled', () => {
    const disabled = fieldBlock('short_text', {}, { required: true, initiallyDisabled: true });
    const enables = (where: 'then' | 'else', enabled = true): Rule => ({
      ...rule('other_1'),
      enabled,
      then: where === 'then' ? [{ type: 'enable', targets: [id('short_text_1')] }] : [],
      else: where === 'else' ? [{ type: 'enable', targets: [id('short_text_1')] }] : [],
    });
    expect(codes('short_text', disabled, [enables('then')])).toEqual([]);
    expect(codes('short_text', disabled, [enables('else')])).toEqual([]);
    expect(codes('short_text', disabled, [enables('then', false)])).toEqual(['required_and_disabled']);
    expect(codes('short_text', disabled, [{ ...enables('then'), then: [{ type: 'disable', targets: [id('short_text_1')] }] }])).toEqual(['required_and_disabled']);
    expect(codes('short_text', disabled, [{ ...enables('then'), then: [{ type: 'enable', targets: [id('other_1')] }] }])).toEqual(['required_and_disabled']);
  });

  it('PROP-06: a switched-off set_value rule is not a value source', () => {
    const readOnly = fieldBlock('short_text', {}, { required: true, readOnly: true });
    expect(codes('short_text', readOnly, [{ ...rule('short_text_1'), enabled: false }])).toEqual(['required_and_readonly_without_source']);
  });

  it('PROP-06: a required read-only field needs a value source', () => {
    const readOnly = { required: true, readOnly: true };
    expect(codes('short_text', fieldBlock('short_text', {}, readOnly))).toEqual(['required_and_readonly_without_source']);
    expect(codes('short_text', fieldBlock('short_text', { defaultValue: { kind: 'static', value: 'x' } }, readOnly))).toEqual([]);
    expect(codes('short_text', fieldBlock('short_text', {}, { ...readOnly, prefill: {} }))).toEqual([]);
    const noPrefill = fieldBlock('short_text', {}, { ...readOnly, prefill: {} });
    expect(codes('short_text', { ...noPrefill, compliance: { ...noPrefill.compliance, allowPrefill: false } })).toEqual(['required_and_readonly_without_source']);
    expect(codes('short_text', fieldBlock('short_text', {}, readOnly), [rule('short_text_1')])).toEqual([]);
    expect(codes('hidden', fieldBlock('hidden', {}, readOnly))).toEqual([]);
    expect(codes('single_choice', fieldBlock('single_choice', { defaultOptionId: id('option_1') }, readOnly))).toEqual([]);
    expect(codes('multi_choice', fieldBlock('multi_choice', { defaultOptionIds: [] }, readOnly))).toEqual(['required_and_readonly_without_source']);
    expect(codes('rating', fieldBlock('rating', { defaultValue: 3 }, readOnly))).toEqual([]);
  });

  it('option images need alt text unless decorative', () => {
    const options = [
      { id: id<OptionId>('a'), label: 'A', image: { assetId: id('img_a') } },
      { id: id<OptionId>('b'), label: 'B', image: { assetId: id('img_b'), decorative: true } },
      { id: id<OptionId>('c'), label: 'C', image: { assetId: id('img_c'), alt: 'Cat' } },
    ];
    const issues = REGISTRY.single_choice.lint(fieldBlock('single_choice', { display: 'image', options: options as never }), definition([]));
    expect(issues).toEqual([expect.objectContaining({ code: 'missing_alt_text', path: '/blocks/single_choice_1/config/options/0/image' })]);
    expect(codes('ranking', fieldBlock('ranking', { options: options as never }))).toEqual(['missing_alt_text']);
    expect(codes('multi_choice', fieldBlock('multi_choice', { options: options as never }))).toEqual(['missing_alt_text']);
  });
});
