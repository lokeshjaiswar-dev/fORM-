import { AVAILABLE_TYPES } from '@form/registry';
import { VALUE_FIELD_TYPES } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { a, choices, field, form, id, page } from './build.ts';
import { ans, codes, run } from './helpers.ts';

/*
 * Table tests per available input type: an empty raw value is unanswered (I9), required only when the
 * field is, a valid answer passes, and each invalid answer fails with exactly the errors the table names.
 */

interface Row {
  block: S.FieldBlock;
  /** Raw control values that normalise to unanswered. */
  blank: Array<S.AnswerValue | null | undefined>;
  valid: S.AnswerValue[];
  /** Each invalid answer with every error it gets (one code, or all of them in report order). */
  invalid: Array<[S.AnswerValue, string | string[]]>;
}

const opts = choices('a', 'b', 'c', 'none');
const decimal = (v: string) => id<S.DecimalString>(v);

const ROWS: Partial<Record<S.ValueFieldType, Row>> = {
  short_text: {
    block: field('short_text', 'f', { config: { minLength: 2, maxLength: 5, pattern: { source: '^[a-z]+$' } } }),
    blank: [a.text(''), null, undefined],
    valid: [a.text('ab'), a.text('abcde')],
    invalid: [[a.text('a'), 'f too_short'], [a.text('abcdef'), 'f too_long'], [a.text('AB1'), 'f pattern'], [ans.raw('short_text', 7), 'f invalid_format']],
  },
  long_text: {
    block: field('long_text', 'f', { config: { rows: 4, limit: { unit: 'words', min: 2, max: 3 } } }),
    blank: [a.long('')],
    valid: [a.long('two words'), a.long('three short words')],
    invalid: [[a.long('one'), 'f too_few_words'], [a.long('one two three four'), 'f too_many_words'], [a.long('x'.repeat(50_001)), 'f too_long']],
  },
  email: {
    block: field('email', 'f', { config: { allowedDomains: ['example.com'] } }),
    blank: [ans.raw('email', { address: '' }), ans.raw('email', { address: '', otpProof: '' })],
    valid: [a.email('asha@example.com'), ans.raw('email', { address: 'asha@example.com', otpProof: '' })],
    invalid: [[a.email('asha@'), 'f.address invalid_email'], [a.email('asha@other.org'), 'f.address email_domain_blocked']],
  },
  phone: {
    block: field('phone', 'f', { config: { defaultCountry: id<S.CountryCode>('IN'), showCountrySelect: true, allowedCountries: [id<S.CountryCode>('IN')] } }),
    blank: [ans.raw('phone', { e164: '', country: 'IN' })],
    valid: [ans.phone('+919812345678')],
    invalid: [[ans.phone('98123'), 'f.e164 invalid_phone'], [ans.phone('+14155550100', 'US'), 'f.country country_not_allowed'], [ans.phone('+14155550100'), 'f.e164 invalid_phone']],
  },
  number: {
    block: field('number', 'f', { config: { display: 'input', min: decimal('1'), max: decimal('100'), step: decimal('0.5') } }),
    blank: [ans.raw('number', '')],
    valid: [a.number('1'), a.number('99.5')],
    invalid: [[a.number('0'), 'f below_min'], [a.number('101'), 'f above_max'], [a.number('2.25'), 'f step'], [ans.raw('number', 'abc'), 'f not_a_number'], [ans.raw('number', 3), 'f not_a_number']],
  },
  url: {
    block: field('url', 'f', { config: { schemes: ['https'] } }),
    blank: [ans.url('')],
    valid: [ans.url('https://example.com/path')],
    invalid: [[ans.url('http://example.com'), 'f invalid_url'], [ans.url('not a url'), 'f invalid_url']],
  },
  single_choice: {
    block: field('single_choice', 'f', { config: { display: 'radio', options: opts, other: { enabled: true, textRequired: true, maxLength: 5 } } }),
    blank: [a.single(null), a.single(null, ''), ans.raw('single_choice', { optionId: null, other: '' })],
    valid: [a.single('a'), a.single(null, 'mine'), ans.raw('single_choice', { optionId: 'b', other: '' })],
    invalid: [[a.single('zzz'), 'f.optionId not_in_options'], [a.single(null, 'too long'), 'f.other too_long'], [a.single('a', 'both'), 'f.other not_in_options']],
  },
  multi_choice: {
    block: field('multi_choice', 'f', { config: { display: 'checkbox', options: opts, minSelected: 2, maxSelected: 3, exclusiveOptionIds: [id<S.OptionId>('none')] } }),
    blank: [a.multi(), ans.raw('multi_choice', { optionIds: [], other: '' })],
    valid: [a.multi('a', 'b'), a.multi('a', 'b', 'c')],
    invalid: [
      [a.multi('a'), 'f too_few_selected'],
      [a.multi('a', 'b', 'c', 'none'), 'f too_many_selected'],
      [a.multi('a', 'zzz'), 'f.optionIds.1 not_in_options'],
      [a.multi('a', 'a'), 'f.optionIds.1 invalid_format'],
      [ans.multiOther('x', 'a', 'b'), 'f.other not_in_options'],
    ],
  },
  date: {
    block: field('date', 'f', {
      config: { pattern: 'DD/MM/YYYY', picker: 'calendar', limits: { min: { kind: 'absolute', date: id<S.IsoDate>('2026-01-01') }, disallowWeekdays: [0] } },
    }),
    blank: [ans.raw('date', '')],
    valid: [a.date('2026-10-19')],
    invalid: [[a.date('2025-12-31'), 'f date_out_of_range'], [a.date('2026-10-18'), 'f date_not_allowed'], [a.date('2026-02-30'), 'f invalid_date']],
  },
  time: {
    block: field('time', 'f', { config: { hourCycle: 'h23', minuteStep: 5, window: { from: id<S.IsoTime>('09:00'), to: id<S.IsoTime>('17:00') } } }),
    blank: [ans.raw('time', { start: '' }), ans.raw('time', { start: '', end: '' })],
    valid: [a.time('09:30'), ans.raw('time', { start: '10:00', end: '' })],
    invalid: [[a.time('08:00'), 'f time_out_of_range'], [ans.timeRange('10:00', '11:00'), 'f.end invalid_time'], [a.time('25:00'), 'f.start invalid_time']],
  },
  rating: {
    block: field('rating', 'f', { config: { max: 5, icon: 'star' } }),
    blank: [null],
    valid: [a.rating(1), a.rating(5)],
    invalid: [[a.rating(0), 'f below_min'], [a.rating(6), 'f above_max'], [a.rating(2.5), 'f not_integer']],
  },
  linear_scale: {
    block: field('linear_scale', 'f', { config: { min: 1, max: 5 } }),
    blank: [undefined],
    valid: [ans.scale(1), ans.scale(5)],
    invalid: [[ans.scale(0), 'f below_min'], [ans.scale(6), 'f above_max']],
  },
  nps: {
    block: field('nps', 'f'),
    blank: [null],
    valid: [a.nps(0), a.nps(10)],
    invalid: [[a.nps(11), 'f above_max'], [a.nps(-1), 'f below_min']],
  },
  ranking: {
    block: field('ranking', 'f', { config: { options: choices('a', 'b', 'c') } }),
    blank: [ans.ranking()],
    valid: [ans.ranking('a', 'b', 'c')],
    invalid: [[ans.ranking('a', 'b', 'c', 'd'), ['f.3 not_in_options', 'f too_many_selected']], [ans.ranking('a', 'b', 'zz'), 'f.2 not_in_options'], [ans.ranking('a', 'b', 'c', 'c'), ['f.3 invalid_format', 'f too_many_selected']], [ans.ranking('a', 'a', 'b'), 'f.1 invalid_format']],
  },
  file_upload: {
    block: field('file_upload', 'f', { config: { ...field('file_upload', 'x').config, maxFiles: 2, minFiles: 1, maxFileBytes: 2 * 1024 * 1024 } }),
    blank: [ans.raw('file_upload', [])],
    valid: [ans.files({})],
    invalid: [
      [ans.files({}, {}, {}), 'f too_many_files'],
      [ans.files({ sizeBytes: 3 * 1024 * 1024 }), 'f.0.sizeBytes file_too_large'],
      [ans.files({ name: 'run.exe', mime: 'application/x-msdownload' }), 'f.0 file_type_not_allowed'],
      [ans.files({ scan: 'infected' }), 'f.0.scan file_infected'],
    ],
  },
  signature: {
    block: field('signature', 'f', { config: { penColor: { token: 'text' }, heightPx: 160, allowTyped: true } }),
    blank: [null],
    valid: [ans.signature('drawn'), ans.signature('typed', 'Asha Rao')],
    invalid: [[ans.signature('typed', '  '), 'f.typedName required'], [ans.raw('signature', { method: 'drawn' }), 'f.file invalid_format']],
  },
};

const INPUT_TYPES: string[] = AVAILABLE_TYPES.filter((t) => (VALUE_FIELD_TYPES as readonly string[]).includes(t) && t !== 'hidden');

describe('validateAnswers per type', () => {
  it('has a table row for every available input type', () => {
    expect(Object.keys(ROWS).sort()).toEqual([...INPUT_TYPES].sort());
  });

  for (const [type, row] of Object.entries(ROWS) as Array<[S.ValueFieldType, Row]>) {
    describe(type, () => {
      const optional = form([row.block], [page('p1', ['f'])]);
      const required = form([{ ...row.block, required: true }], [page('p1', ['f'])]);

      it('treats blank control values as unanswered: required only when the field is', () => {
        for (const value of row.blank) {
          expect(codes(run(optional, { f: value }).errors), JSON.stringify(value)).toEqual([]);
          expect(codes(run(required, { f: value }).errors), JSON.stringify(value)).toEqual(['f required']);
        }
        expect(codes(run(required, {}).errors)).toEqual(['f required']);
      });

      it('accepts valid answers', () => {
        for (const value of row.valid) {
          expect(codes(run(optional, { f: value }).errors), JSON.stringify(value)).toEqual([]);
          expect(codes(run(required, { f: value }).errors), JSON.stringify(value)).toEqual([]);
        }
      });

      it('rejects each invalid answer for the expected reason', () => {
        for (const [value, expected] of row.invalid) {
          const { errors } = run(optional, { f: value });
          expect(codes(errors), JSON.stringify(value).slice(0, 80)).toEqual([expected].flat());
          for (const e of errors) expect(e.message.length, e.code).toBeGreaterThan(0);
        }
      });

      it('reports an answer of another type as invalid_format', () => {
        const other: S.AnswerValue = type === 'short_text' ? a.long('x') : a.text('x');
        expect(codes(run(optional, { f: other }).errors)).toEqual(['f invalid_format']);
      });
    });
  }
});
