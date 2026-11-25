import { describe, expect, it } from 'vitest';
import type { ChoiceOption, OptionId } from '@form/schema';
import { importPairs, pasteIntoGroup } from '@/lib/pasteOptions';

const opt = (id: string, label: string, extra: Partial<ChoiceOption> = {}): ChoiceOption => ({ id: id as OptionId, label, ...extra });
const ids = () => {
  let n = 0;
  return () => `new_${(n += 1)}`;
};
const countries = [opt('in', 'India', { code: 'IN' }), opt('us', 'USA')];

describe('pasteIntoGroup', () => {
  it('adds one option per line to the group, keeping commas as part of the name', () => {
    const result = pasteIntoGroup([], 'in' as OptionId, 'Delhi, NCR\n\n  Goa  \n', ids());
    expect(result.options).toEqual([
      { id: 'new_1', label: 'Delhi, NCR', parentOptionIds: ['in'] },
      { id: 'new_2', label: 'Goa', parentOptionIds: ['in'] },
    ]);
    expect(result).toMatchObject({ added: 2, linked: 2 });
  });

  it('an option already in the list joins the group instead of being repeated, and the input is left as it was', () => {
    const current = [opt('mh', 'Maharashtra', { code: 'MH', parentOptionIds: ['in' as OptionId] })];
    const result = pasteIntoGroup(current, 'us' as OptionId, 'maharashtra\nTexas', ids());
    expect(result.options).toEqual([
      { id: 'mh', label: 'Maharashtra', code: 'MH', parentOptionIds: ['in', 'us'] },
      { id: 'new_1', label: 'Texas', parentOptionIds: ['us'] },
    ]);
    expect(current[0]?.parentOptionIds).toEqual(['in']);
  });

  it('with no group, lines become options shown for every answer', () => {
    expect(pasteIntoGroup([], null, 'Not listed', ids()).options).toEqual([{ id: 'new_1', label: 'Not listed' }]);
  });
});

describe('importPairs', () => {
  it('creates each option once and links it to every parent answer it appears with (tabs or commas)', () => {
    const result = importPairs([], countries, 'India, Maharashtra\nindia ,  Karnataka\nUSA\tTexas\nIN, Goa\nUSA, Maharashtra\nNot listed', ids());
    expect(result.options).toEqual([
      { id: 'new_1', label: 'Maharashtra', parentOptionIds: ['in', 'us'] },
      { id: 'new_2', label: 'Karnataka', parentOptionIds: ['in'] },
      { id: 'new_3', label: 'Texas', parentOptionIds: ['us'] },
      { id: 'new_4', label: 'Goa', parentOptionIds: ['in'] },
      { id: 'new_5', label: 'Not listed' },
    ]);
    expect(result).toMatchObject({ added: 5, linked: 5, unknownParents: [] });
  });

  it('a tab keeps a comma inside the option name', () => {
    expect(importPairs([], countries, 'India\tDelhi, NCR', ids()).options).toEqual([{ id: 'new_1', label: 'Delhi, NCR', parentOptionIds: ['in'] }]);
  });

  it('skips rows naming a parent answer that does not exist, and reports it once', () => {
    const result = importPairs([], countries, 'Japan, Tokyo\nJapan, Osaka\nUSA, Texas', ids());
    expect(result.options.map((o) => o.label)).toEqual(['Texas']);
    expect(result.unknownParents).toEqual(['Japan']);
  });
});
