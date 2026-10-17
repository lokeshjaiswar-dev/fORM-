import { describe, expect, it } from 'vitest';
import { extract, extractFromSource, buildCatalogs } from '../scripts/extractor';
import { EN_DATE_NAMES, EN_IN, SYSTEM_MESSAGES, createI18n } from '../src/index';
import { SPEC_SYSTEM_MESSAGE_KEYS } from './system-message-keys';

const DATE_NAME_KEYS = [
  ...EN_DATE_NAMES.monthsShort.map((_, i) => `date.month_short.${i + 1}`),
  ...EN_DATE_NAMES.monthsLong.map((_, i) => `date.month_long.${i + 1}`),
  'time.am',
  'time.pm',
];

describe('en-IN system catalogue', () => {
  const system = EN_IN.system ?? {};

  it('has a message for every SYSTEM_MESSAGE_KEYS entry', () => {
    expect(createI18n('en-IN', EN_IN).missing('system', SPEC_SYSTEM_MESSAGE_KEYS)).toEqual([]);
  });

  it('contains only system message keys and date names', () => {
    const allowed = new Set<string>([...SPEC_SYSTEM_MESSAGE_KEYS, ...DATE_NAME_KEYS]);
    expect(Object.keys(system).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('matches the built-in English date names', () => {
    const i18n = createI18n('en-IN', EN_IN);
    expect(i18n.dateNames).toEqual(EN_DATE_NAMES);
  });

  it('exposes typed ids for the source messages', () => {
    expect(SYSTEM_MESSAGES['nav.next']).toBe('system:nav.next');
    expect(Object.keys(SYSTEM_MESSAGES).sort()).toEqual(Object.keys(system).sort());
  });
});

describe('i18n:extract', () => {
  it('leaves the committed catalogues unchanged', () => {
    expect(extract({ check: true })).toEqual({ errors: [], stale: [] });
  });

  it('reads literal defineMessages calls', () => {
    const { messages, errors } = extractFromSource(
      'a.ts',
      `const m = defineMessages('renderer', { 'upload.remove': 'Remove {name}', title: \`Upload\` });`,
    );
    expect(errors).toEqual([]);
    expect(messages.map(({ namespace, key, message }) => [namespace, key, message])).toEqual([
      ['renderer', 'upload.remove', 'Remove {name}'],
      ['renderer', 'title', 'Upload'],
    ]);
  });

  it('rejects messages it cannot read statically', () => {
    const { errors } = extractFromSource(
      'b.ts',
      [
        `defineMessages(ns, { a: 'A' });`,
        `defineMessages('nope', { a: 'A' });`,
        `defineMessages('builder', messages);`,
        `defineMessages('builder', { a: label, [k]: 'B', ...rest });`,
      ].join('\n'),
    );
    expect(errors).toHaveLength(6);
    expect(errors[0]).toMatch(/^b\.ts:1:1: the namespace/);
  });

  it('rejects conflicting duplicates and invalid ICU', () => {
    const at = (key: string, message: string, location: string) => ({ namespace: 'builder' as const, key, message, location });
    const { catalogs, errors } = buildCatalogs([
      at('save', 'Save', 'a.ts:1:1'),
      at('save', 'Save', 'b.ts:1:1'),
      at('save', 'Store', 'c.ts:1:1'),
      at('count', '{n, plural, one {# item}}', 'd.ts:1:1'),
      at('add', 'Add', 'e.ts:1:1'),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('builder:save is already defined differently at a.ts:1:1');
    expect(errors[1]).toContain('builder:count is not valid ICU MessageFormat');
    expect(Object.keys(catalogs.builder)).toEqual(['add', 'save']);
  });
});
