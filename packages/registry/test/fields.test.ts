import { describe, expect, it } from 'vitest';
import { ANSWER_VALUE_SCHEMAS, BLOCK_SCHEMAS, type BlockConfigMap, type ValidationErrorCode, type ValueFieldType } from '@form/schema';
import { AVAILABLE_TYPES, REGISTRY, valueDefinition, type AvailableType } from '../src/index.ts';
import { EN_IN, fieldBlock, file } from './fixtures.ts';

type AvailableValueType = Extract<AvailableType, ValueFieldType>;

interface Case<T extends AvailableValueType> {
  config?: Partial<BlockConfigMap[T]>;
  required?: boolean;
  valid: unknown[];
  /**
   * At least five, each failing `answerSchema` with the expected code, or with TWIN when the answer twin
   * itself rejects the value (types without config-dependent answer rules have only TWIN samples).
   */
  invalid: Array<readonly [unknown, ValidationErrorCode | typeof TWIN]>;
  /** Values the I9 rule forbids: `isEmpty` is true and the answer twin rejects them. */
  empty: unknown[];
}

const TWIN = 'twin';
const MIB = 1024 * 1024;
const pdf = file('cv.pdf', 'application/pdf');
const png = file('photo.png', 'image/png');

const CASES: { [T in AvailableValueType]: Case<T> } = {
  short_text: {
    config: { minLength: 2, maxLength: 5 },
    valid: ['ab', 'hello', 'नमस्ते', '👍🏽👍🏽'],
    invalid: [['a', 'too_short'], ['toolong', 'too_long'], ['👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽', 'too_long'], [' ', 'too_short'], ['', TWIN], [42, TWIN], [null, TWIN], [['ab'], TWIN]],
    empty: [''],
  },
  long_text: {
    config: { limit: { unit: 'words', min: 2, max: 4 } },
    valid: ['two words', 'one two three four', 'line one\nline two'],
    invalid: [['one', 'too_few_words'], ['one two three four five', 'too_many_words'], ['  lone  ', 'too_few_words'], ['', TWIN], [7, TWIN], [{}, TWIN]],
    empty: [''],
  },
  email: {
    config: { allowedDomains: ['@Example.com'] },
    valid: [{ address: 'asha@example.com' }, { address: 'Asha@EXAMPLE.COM', otpProof: 'proof' }],
    invalid: [[{ address: 'asha@other.com' }, 'email_domain_blocked'], [{ address: 'asha@example.co' }, 'email_domain_blocked'], [{ address: 'not-an-email' }, TWIN], [{ address: '' }, TWIN], ['asha@example.com', TWIN], [{}, TWIN]],
    empty: [{ address: '' }],
  },
  phone: {
    config: { allowedCountries: ['IN'] as never },
    valid: [{ e164: '+919812345678', country: 'IN' }],
    invalid: [
      [{ e164: '+14155550100', country: 'US' }, 'country_not_allowed'], [{ e164: '+14155550100', country: 'IN' }, 'invalid_phone'], [{ e164: '+4498123', country: 'IN' }, 'invalid_phone'],
      [{ e164: '9812345678', country: 'IN' }, TWIN], [{ e164: '', country: 'IN' }, TWIN], [{ e164: '+919812345678' }, TWIN], ['+919812345678', TWIN],
    ],
    empty: [{ e164: '', country: 'IN' }],
  },
  number: {
    config: { min: '0' as never, max: '100' as never, step: '0.5' as never },
    valid: ['0', '42.5', '100'],
    invalid: [['-1', 'below_min'], ['100.5', 'above_max'], ['1.25', 'step'], ['abc', TWIN], [12, TWIN], ['', TWIN], ['1e3', TWIN]],
    empty: [''],
  },
  url: {
    valid: ['https://example.com', 'http://example.co.in/path?q=1#top', 'HTTPS://Example.com:8443/x'],
    invalid: [['ftp://example.com', 'invalid_url'], ['example.com', 'invalid_url'], ['https://localhost', 'invalid_url'], ['https://user@example.com', 'invalid_url'], ['javascript:alert(1)', 'invalid_url'], ['', TWIN]],
    empty: [''],
  },
  single_choice: {
    config: { other: { enabled: true, textRequired: true, maxLength: 10 } },
    valid: [{ optionId: 'option_1' }, { optionId: null, other: 'Mine' }],
    invalid: [
      [{ optionId: 'nope' }, 'not_in_options'], [{ optionId: 'option_1', other: 'x' }, 'not_in_options'], [{ optionId: null, other: 'way too long text' }, 'too_long'],
      [{ optionId: null }, TWIN], ['option_1', TWIN], [{ optionIds: ['option_1'] }, TWIN],
    ],
    empty: [{ optionId: null }],
  },
  multi_choice: {
    config: { minSelected: 1, maxSelected: 2, exclusiveOptionIds: ['option_3'] as never },
    valid: [{ optionIds: ['option_1'] }, { optionIds: ['option_1', 'option_2'] }, { optionIds: ['option_3'] }],
    invalid: [
      [{ optionIds: ['option_1', 'option_2', 'option_3'] }, 'too_many_selected'], [{ optionIds: ['option_1', 'option_3'] }, 'too_many_selected'],
      [{ optionIds: ['nope'] }, 'not_in_options'], [{ optionIds: ['option_1', 'option_1'] }, 'invalid_format'], [{ optionIds: ['option_1'], other: 'x' }, 'not_in_options'],
      [{ optionIds: [] }, TWIN],
    ],
    empty: [{ optionIds: [] }],
  },
  date: {
    config: {
      limits: {
        min: { kind: 'absolute', date: '2024-01-01' as never },
        max: { kind: 'absolute', date: '2024-12-31' as never },
        disallowWeekdays: [0],
        disallowDates: ['2024-08-15' as never, { from: '2024-10-01' as never, to: '2024-10-03' as never }],
      },
    },
    valid: ['2024-06-03', '2024-01-01', '2024-10-04'],
    invalid: [
      ['2023-12-31', 'date_out_of_range'], ['2025-01-01', 'date_out_of_range'], ['2024-06-02', 'date_not_allowed'], ['2024-08-15', 'date_not_allowed'],
      ['2024-10-02', 'date_not_allowed'], ['2024-02-30', TWIN], ['03-06-2024', TWIN], ['', TWIN],
    ],
    empty: [''],
  },
  time: {
    config: { hourCycle: 'h23', range: { enabled: true, minMinutes: 30, maxMinutes: 120 }, window: { from: '09:00' as never, to: '18:00' as never } },
    valid: [{ start: '09:00', end: '10:00' }, { start: '16:00', end: '18:00' }],
    invalid: [
      [{ start: '09:00' }, 'invalid_time'], [{ start: '10:00', end: '09:00' }, 'time_out_of_range'], [{ start: '09:00', end: '09:15' }, 'time_out_of_range'],
      [{ start: '08:00', end: '09:00' }, 'time_out_of_range'], [{ start: '09:00', end: '12:00' }, 'time_out_of_range'], [{ start: '25:00', end: '26:00' }, TWIN],
    ],
    empty: [{ start: '' }],
  },
  rating: {
    config: { max: 5 },
    valid: [1, 5],
    invalid: [[6, 'above_max'], [10, 'above_max'], [0, 'below_min'], [2.5, TWIN], ['3', TWIN], [null, TWIN], [11, TWIN]],
    empty: [],
  },
  linear_scale: {
    config: { min: 1, max: 5 },
    valid: [1, 3, 5],
    invalid: [[0, 'below_min'], [6, 'above_max'], [10, 'above_max'], [1.5, TWIN], ['3', TWIN], [-1, TWIN]],
    empty: [],
  },
  nps: {
    valid: [0, 7, 10],
    invalid: [[-1, TWIN], [11, TWIN], [5.5, TWIN], ['7', TWIN], [null, TWIN]],
    empty: [],
  },
  ranking: {
    required: true,
    valid: [['option_2', 'option_1', 'option_3']],
    invalid: [
      [['option_1'], 'too_few_selected'], [['option_1', 'option_1', 'option_2'], 'invalid_format'], [['nope', 'option_1', 'option_2'], 'not_in_options'],
      [['option_1', 'option_2', 'option_3', 'option_1'], 'invalid_format'], [[], TWIN], ['option_1', TWIN],
    ],
    empty: [[]],
  },
  file_upload: {
    config: { maxFiles: 2, minFileBytes: 1 },
    valid: [[pdf], [png, file('scan.JPG', 'image/jpeg')]],
    invalid: [
      [[file('run.exe', 'application/x-msdownload')], 'file_type_not_allowed'], [[pdf, png, file('b.pdf', 'application/pdf')], 'too_many_files'],
      [[file('big.pdf', 'application/pdf', 20 * MIB)], 'file_too_large'], [[file('bad.pdf', 'application/pdf', 1000, { scan: 'infected' })], 'file_infected'],
      [[file('empty.pdf', 'application/pdf', 0)], 'file_too_small'], [[pdf, pdf], 'invalid_format'], [[file('notes.txt', 'application/pdf')], 'file_type_not_allowed'],
      [[], TWIN],
    ],
    empty: [[]],
  },
  signature: {
    config: { allowTyped: false },
    valid: [{ method: 'drawn', file: png }],
    invalid: [
      [{ method: 'typed', file: png, typedName: 'Asha' }, 'invalid_format'], [{ method: 'drawn' }, TWIN], [{ method: 'scribble', file: png }, TWIN],
      ['data:image/png;base64,AAAA', TWIN], [{}, TWIN],
    ],
    empty: [],
  },
  hidden: {
    valid: ['newsletter', 'utm-42'],
    invalid: [['', TWIN], [3, TWIN], [null, TWIN], [{}, TWIN], [[], TWIN]],
    empty: [''],
  },
};

const codesOf = (result: { success: boolean; error?: unknown }): string[] =>
  ((result.error as { issues?: Array<{ params?: { code?: string } }> } | undefined)?.issues ?? []).map((i) => i.params?.code ?? '');

const VALUE_TYPES = AVAILABLE_TYPES.filter((t): t is AvailableValueType => REGISTRY[t].kind === 'input');

describe('table per available value type', () => {
  it('covers every available value type', () => {
    expect(Object.keys(CASES).sort()).toEqual([...VALUE_TYPES].sort());
  });

  describe.each(VALUE_TYPES)('%s', (type) => {
    const def = valueDefinition<AvailableValueType>(type);
    const c = CASES[type] as Case<AvailableValueType>;
    const block = fieldBlock(type, c.config as never);
    const schema = def.answerSchema(block as never, { required: c.required ?? false });
    const twin = ANSWER_VALUE_SCHEMAS[type];

    it('default config parses (config schema and the block twin)', () => {
      const config = def.defaultConfig(EN_IN);
      expect(def.configSchema.safeParse(config).success).toBe(true);
      expect(BLOCK_SCHEMAS[type].safeParse(fieldBlock(type)).success).toBe(true);
    });

    it('every palette entry yields a valid config', () => {
      expect(def.palette.length).toBeGreaterThan(0);
      for (const entry of def.palette) {
        expect(def.configSchema.safeParse({ ...def.defaultConfig(EN_IN), ...entry.configOverrides }).success).toBe(true);
        expect(entry.labelKey).toMatch(/^builder:palette\./);
      }
    });

    it('the test block config parses', () => {
      expect(def.configSchema.safeParse(block.config).success).toBe(true);
    });

    it('accepts the valid samples, which the answer twin also accepts', () => {
      for (const value of c.valid) {
        expect(schema.safeParse(value), JSON.stringify(value)).toMatchObject({ success: true });
        expect(twin.safeParse({ type, value }).success).toBe(true);
      }
    });

    it('rejects at least five invalid samples, each for the expected reason', () => {
      expect(c.invalid.length).toBeGreaterThanOrEqual(5);
      for (const [value, code] of c.invalid) {
        const label = `${JSON.stringify(value)} -> ${code}`;
        const result = schema.safeParse(value);
        expect(result.success, label).toBe(false);
        expect(twin.safeParse({ type, value }).success, label).toBe(code !== TWIN);
        if (code !== TWIN) expect(codesOf(result), label).toContain(code);
      }
    });

    it('isEmpty agrees with I9', () => {
      for (const value of c.valid) expect(def.isEmpty(value as never)).toBe(false);
      for (const value of c.empty) {
        expect(def.isEmpty(value as never)).toBe(true);
        expect(twin.safeParse({ type, value }).success).toBe(false);
      }
    });

    it('exports one cell per column and readable text', () => {
      const columns = def.export.columns(block as never);
      expect(columns.length).toBeGreaterThan(0);
      for (const value of c.valid) {
        expect(def.export.cells(value as never, block as never)).toHaveLength(columns.length);
        expect(def.export.text(value as never, block as never).length).toBeGreaterThan(0);
      }
    });

    it('declares operators for every path kind and reads every path without throwing', () => {
      const kinds = new Set(Object.values(def.paths));
      expect(new Set(Object.keys(def.operators))).toEqual(kinds);
      for (const value of c.valid) {
        for (const path of [undefined, ...Object.keys(def.paths), 'no_such_path']) {
          expect(def.toScalar(value as never, path)).toHaveProperty('t');
        }
        expect(def.toScalar(value as never, 'no_such_path')).toEqual({ t: 'null' });
      }
    });
  });
});

describe('answer issues carry validation codes', () => {
  it('reports the code as the message and in params', () => {
    const def = valueDefinition('number');
    const result = def.answerSchema(fieldBlock('number', { max: '10' as never }), { required: false }).safeParse('11');
    expect(result.success).toBe(false);
    const issues = (result as { error: { issues: Array<{ message: string; params?: { code?: string } }> } }).error.issues;
    expect(issues).toEqual([expect.objectContaining({ message: 'above_max', params: { code: 'above_max' } })]);
  });

  it('number: integers, negatives and steps from min', () => {
    const answer = (config: Partial<BlockConfigMap['number']>, value: string) =>
      valueDefinition('number').answerSchema(fieldBlock('number', config), { required: false }).safeParse(value).success;
    expect(answer({ integerOnly: true }, '3')).toBe(true);
    expect(answer({ integerOnly: true }, '3.5')).toBe(false);
    expect(answer({ allowNegative: false }, '-0.1')).toBe(false);
    expect(answer({ min: '1' as never, step: '2' as never }, '5')).toBe(true);
    expect(answer({ min: '1' as never, step: '2' as never }, '4')).toBe(false);
  });

  it('long_text: character limits and the hard cap', () => {
    const block = fieldBlock('long_text', { limit: { unit: 'characters', max: 3 } });
    const schema = valueDefinition('long_text').answerSchema(block, { required: false });
    expect(schema.safeParse('abc').success).toBe(true);
    expect(schema.safeParse('abcd').success).toBe(false);
  });

  it('time: am/pm periods and single times', () => {
    const answer = (config: Partial<BlockConfigMap['time']>, value: unknown) =>
      valueDefinition('time').answerSchema(fieldBlock('time', config), { required: false }).safeParse(value).success;
    expect(answer({ period: 'am_only' }, { start: '11:55' })).toBe(true);
    expect(answer({ period: 'am_only' }, { start: '12:00' })).toBe(false);
    expect(answer({ period: 'pm_only' }, { start: '11:55' })).toBe(false);
    expect(answer({}, { start: '10:00', end: '11:00' })).toBe(false);
  });

  it('signature: typed needs a name when allowed', () => {
    const schema = valueDefinition('signature').answerSchema(fieldBlock('signature'), { required: false });
    expect(schema.safeParse({ method: 'typed', file: png, typedName: 'Asha Rao' }).success).toBe(true);
    expect(schema.safeParse({ method: 'typed', file: png, typedName: '  ' }).success).toBe(false);
  });

  it('file_upload: empty allowlists accept any type; minFiles applies', () => {
    const block = fieldBlock('file_upload', { maxFiles: 3, minFiles: 2, accept: { extensions: [], mimeTypes: ['image/*'] } });
    const schema = valueDefinition('file_upload').answerSchema(block, { required: false });
    expect(schema.safeParse([png, file('x.heic', 'image/heic')]).success).toBe(true);
    expect(schema.safeParse([png]).success).toBe(false);
    expect(schema.safeParse([png, pdf]).success).toBe(false);
  });
});

describe('config rules beyond the twin', () => {
  const rejects = <T extends AvailableValueType>(type: T, config: Partial<BlockConfigMap[T]>) =>
    expect(valueDefinition(type).configSchema.safeParse({ ...valueDefinition(type).defaultConfig(EN_IN), ...config }).success, `${type} ${JSON.stringify(config)}`).toBe(false);

  it('rejects contradictory bounds and dangling defaults', () => {
    rejects('short_text', { minLength: 5, maxLength: 2 });
    rejects('long_text', { limit: { unit: 'words', min: 5, max: 2 } });
    rejects('phone', { allowedCountries: ['US'] as never });
    rejects('number', { min: '5' as never, max: '1' as never });
    rejects('number', { step: '0' as never });
    rejects('number', { min: '1' as never, defaultValue: '0' as never });
    rejects('number', { max: '1' as never, defaultValue: '2' as never });
    rejects('single_choice', { defaultOptionId: 'nope' as never });
    rejects('single_choice', { shuffle: { keepLast: 4 } });
    rejects('multi_choice', { minSelected: 3, maxSelected: 1 });
    rejects('multi_choice', { minSelected: 4 });
    rejects('multi_choice', { defaultOptionIds: ['nope'] as never });
    rejects('multi_choice', { exclusiveOptionIds: ['nope'] as never });
    rejects('multi_choice', { shuffle: { keepLast: 9 } });
    rejects('date', { limits: { min: { kind: 'absolute', date: '2024-12-31' as never }, max: { kind: 'absolute', date: '2024-01-01' as never } } });
    rejects('date', { limits: { disallowDates: [{ from: '2024-02-02' as never, to: '2024-02-01' as never }] } });
    rejects('time', { range: { enabled: true, minMinutes: 60, maxMinutes: 30 } });
    rejects('rating', { max: 0 });
    rejects('rating', { max: 11 });
    rejects('rating', { max: 5, defaultValue: 6 });
    rejects('linear_scale', { max: 1 });
    rejects('linear_scale', { max: 11 });
    rejects('ranking', { rankTop: 4 });
    rejects('file_upload', { minFiles: 3, maxFiles: 1 });
    rejects('file_upload', { minFileBytes: 10, maxFileBytes: 5 });
  });

  it('rejects defaults the field could never accept', () => {
    const accepts = <T extends AvailableValueType>(type: T, config: Partial<BlockConfigMap[T]>) =>
      expect(valueDefinition(type).configSchema.safeParse({ ...valueDefinition(type).defaultConfig(EN_IN), ...config }).success, `${type} ${JSON.stringify(config)}`).toBe(true);
    const window = { from: '09:00' as never, to: '18:00' as never };
    rejects('time', { window: { from: '18:00' as never, to: '09:00' as never } });
    rejects('time', { window, defaultValue: { kind: 'fixed', time: '08:59' as never } });
    accepts('time', { window, defaultValue: { kind: 'fixed', time: '09:00' as never } });
    const limits = { min: { kind: 'absolute', date: '2024-01-01' as never }, max: { kind: 'absolute', date: '2024-12-31' as never } } as const;
    rejects('date', { limits, defaultValue: { kind: 'fixed', date: '2025-01-01' as never } });
    accepts('date', { limits, defaultValue: { kind: 'fixed', date: '2024-12-31' as never } });
    rejects('short_text', { maxLength: 3, defaultValue: { kind: 'static', value: 'four' } });
    accepts('short_text', { maxLength: 3, defaultValue: { kind: 'static', value: '👍🏽👍🏽👍🏽' } });
    rejects('long_text', { limit: { unit: 'words', max: 2 }, defaultValue: { kind: 'static', value: 'one two three' } });
    rejects('long_text', { limit: { unit: 'characters', max: 2 }, defaultValue: { kind: 'static', value: 'abc' } });
    rejects('multi_choice', { maxSelected: 1, defaultOptionIds: ['option_1', 'option_2'] as never });
    accepts('multi_choice', { maxSelected: 2, defaultOptionIds: ['option_1', 'option_2'] as never });
    rejects('number', { allowNegative: false, min: '-1' as never });
    rejects('number', { allowNegative: false, defaultValue: '-1' as never });
    accepts('number', { allowNegative: false, min: '0' as never, defaultValue: '0' as never });
  });
});
