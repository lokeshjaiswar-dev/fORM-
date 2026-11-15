import { describe, expect, it } from 'vitest';
import { searchDocFor } from './search-doc.ts';
import { answers, definitionOf, encrypted, fieldBlock, group, sensitive } from './test-fixtures.ts';

const version = (def: ReturnType<typeof definitionOf>, taint?: Record<string, { classification: 'none' | 'personal' | 'sensitive'; purposeIds: string[] }>) =>
  ({ definition: def, compiled: { taint } }) as Parameters<typeof searchDocFor>[0];

describe('searchDocFor', () => {
  const def = definitionOf([fieldBlock('name', 'short_text'), sensitive(fieldBlock('pan', 'short_text')), encrypted(fieldBlock('phone', 'short_text')), fieldBlock('city', 'short_text'), fieldBlock('mail', 'email')]);

  it('holds the text of the plain answers, in the form’s order, as the field types read them', () => {
    const doc = searchDocFor(version(def), answers({ city: ['short_text', 'Pune'], mail: ['email', { address: 'asha@example.test' }], name: ['short_text', 'Asha Rao'] }));
    expect(doc).toEqual(['Asha Rao', 'Pune', 'asha@example.test']);
  });

  it('skips encrypt and sensitive fields, so their text can never be found', () => {
    const doc = searchDocFor(
      version(def),
      answers({ name: ['short_text', 'Asha'], pan: ['short_text', 'ABCDE1234F'], phone: ['short_text', '9876543210'] }),
    );
    expect(doc).toEqual(['Asha']);
    expect(doc.join(' ')).not.toMatch(/ABCDE|9876/);
  });

  it('skips a value derived from a sensitive one (taint, I13) but not one derived from a personal one', () => {
    // Any block can carry a taint entry; in a real version it is a calculation or a captured value.
    const withDerived = definitionOf([fieldBlock('name', 'short_text'), fieldBlock('score', 'short_text'), fieldBlock('copy', 'short_text')]);
    const values = answers({ name: ['short_text', 'Asha'], score: ['short_text', 'derived-from-pan'], copy: ['short_text', 'derived-from-name'] });
    const taint = { 'value:score': { classification: 'sensitive' as const, purposeIds: ['pur_1'] }, 'value:copy': { classification: 'personal' as const, purposeIds: ['pur_1'] } };
    expect(searchDocFor(version(withDerived, taint), values)).toEqual(['Asha', 'derived-from-name']);
    // The same answers with no taint recorded are all searchable: the skip is the taint's, not the type's.
    expect(searchDocFor(version(withDerived), values)).toEqual(['Asha', 'derived-from-pan', 'derived-from-name']);
  });

  it('skips a repeating group that has a sensitive field among its children: its text is its rows’ text', () => {
    const open = definitionOf([group('people', ['who'])], [fieldBlock('who', 'short_text')]);
    const closed = definitionOf([group('people', ['who', 'pan'])], [fieldBlock('who', 'short_text'), sensitive(fieldBlock('pan', 'short_text'))]);
    const rows = { rows: [{ rowId: 'r1', values: { who: { type: 'short_text', value: 'Ravi' }, pan: { type: 'short_text', value: 'ABCDE1234F' } } }] };
    expect(searchDocFor(version(open), answers({ people: ['repeating_group', rows] })).join(' ')).toContain('Ravi');
    expect(searchDocFor(version(closed), answers({ people: ['repeating_group', rows] }))).toEqual([]);
  });

  it('skips an answer that is an encrypted envelope, and an answer the version has no field for, and empty text', () => {
    const envelope = { name: { type: 'short_text', enc: { alg: 'A256GCM', kid: 'k', iv: 'i', ct: 'c', aad: 'a:b' } } };
    expect(searchDocFor(version(def), envelope as never)).toEqual([]);
    expect(searchDocFor(version(def), answers({ stray: ['short_text', 'not in the form'], name: ['short_text', '   '] }))).toEqual([]);
    expect(searchDocFor(version(def), answers({}))).toEqual([]);
  });

  it('makes text the index can store out of text it cannot (control characters)', () => {
    expect(searchDocFor(version(def), answers({ name: ['short_text', 'a\u0000b\u0007c'] }))).toEqual(['a b c']);
  });
});
