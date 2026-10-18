import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): { root: string; catalogDir: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'i18n-extract-'));
    roots.push(root);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
    }
    const catalogDir = path.join(root, 'catalogs');
    mkdirSync(catalogDir);
    return { root, catalogDir };
  }

  it('writes sorted catalogues from apps and packages sources, then reports them as current', () => {
    const { root, catalogDir } = fixture({
      'apps/web/src/a.tsx': `import { defineMessages as dm } from '@form/i18n';\nexport const m = dm('renderer', { b: 'B', a: 'A' });`,
      'packages/x/src/b.ts': `import * as i18n from '@form/i18n';\nexport const m = i18n.defineMessages('builder', { save: 'Save' });`,
      'packages/x/src/b.test.ts': `defineMessages('builder', { ignored: 'Ignored' });`,
      'packages/x/src/plain.ts': `export const x = 1;`,
    });
    const read = (ns: string) => JSON.parse(readFileSync(path.join(catalogDir, `${ns}.json`), 'utf8')) as unknown;
    expect(extract({ root, catalogDir, check: true }).stale).toHaveLength(3);
    expect(extract({ root, catalogDir }).errors).toEqual([]);
    expect(Object.entries(read('renderer') as object)).toEqual([['a', 'A'], ['b', 'B']]);
    expect(read('builder')).toEqual({ save: 'Save' });
    expect(read('system')).toEqual({});
    expect(extract({ root, catalogDir, check: true })).toEqual({ errors: [], stale: [] });
  });

  it('reports errors without writing anything', () => {
    const { root, catalogDir } = fixture({ 'packages/x/src/a.ts': `defineMessages('builder', { when: '{d, date}' });` });
    const { errors, stale } = extract({ root, catalogDir });
    expect(errors).toEqual([expect.stringMatching(/^packages\/x\/src\/a\.ts:1:29: builder:when is not valid ICU/)]);
    expect(stale).toEqual([]);
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

  it('reads imported aliases and member calls, and rejects indirect references', () => {
    const { messages, errors } = extractFromSource(
      'c.ts',
      [
        `import { defineMessages as dm } from '@form/i18n';`,
        `import * as i18n from '@form/i18n';`,
        `export { defineMessages } from '@form/i18n';`,
        `dm('renderer', { a: 'A' });`,
        `i18n.defineMessages('builder', { b: 'B' });`,
        `const hidden = dm;`,
        `const other = i18n.defineMessages;`,
      ].join('\n'),
    );
    expect(messages.map(({ namespace, key }) => `${namespace}:${key}`)).toEqual(['renderer:a', 'builder:b']);
    expect(errors).toEqual([
      'c.ts:6:16: call dm directly so its messages can be extracted',
      'c.ts:7:20: call defineMessages directly so its messages can be extracted',
    ]);
  });

  it('rejects conflicting duplicates and invalid ICU', () => {
    const at = (key: string, message: string, location: string) => ({ namespace: 'builder' as const, key, message, location });
    const { catalogs, errors } = buildCatalogs([
      at('save', 'Save', 'a.ts:1:1'),
      at('save', 'Save', 'b.ts:1:1'),
      at('save', 'Store', 'c.ts:1:1'),
      at('count', '{n, plural, one {# item}}', 'd.ts:1:1'),
      at('add', 'Add', 'e.ts:1:1'),
      at('when', 'Due {d, date, short}', 'f.ts:1:1'),
      at('at', 'At {t, time}', 'g.ts:1:1'),
      at('pct', '{p, number, percent}', 'h.ts:1:1'),
      at('total', 'Total {n, number}', 'i.ts:1:1'),
    ]);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toContain('builder:save is already defined differently at a.ts:1:1');
    expect(errors[1]).toContain('builder:count is not valid ICU MessageFormat');
    expect(errors[2]).toContain('{d, date}: date and time arguments are not supported');
    expect(errors[3]).toContain('{t, time}: date and time arguments are not supported');
    expect(errors[4]).toContain('{p, number, …}: number styles and skeletons are not supported');
    expect(Object.keys(catalogs.builder)).toEqual(['add', 'save', 'total']);
  });
});
