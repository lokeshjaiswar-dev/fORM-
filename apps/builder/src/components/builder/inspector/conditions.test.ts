import { describe, expect, it } from 'vitest';
import { AVAILABLE_TYPES } from '@form/registry';
import type { ConditionId, FieldBlock, IsoDate, IsoInstant, Operand, Rule, RuleId, StoredBlock } from '@form/schema';
import { isField } from '@/lib/definition';
import { previewVersion } from '@/lib/preview';
import { block, formWith, text } from '@/test/fixtures';
import { firstOperator, localToday, operatorsFor, retarget, type Defaults } from '@/components/builder/inspector/conditions';

const DEFAULTS: Defaults = { today: '2026-10-18' as IsoDate };
const NOW = '2026-10-18T10:00:00.000Z' as IsoInstant;

const sources = AVAILABLE_TYPES.map((type) => block(type, 'src') as StoredBlock).filter((b): b is FieldBlock => isField(b) && operatorsFor(b).length > 0);

function compiles(source: FieldBlock, condition: Rule['when']['children'][number]) {
  const rule: Rule = {
    id: 'r1' as RuleId,
    enabled: true,
    when: { kind: 'group', id: 'g1' as ConditionId, combinator: 'all', children: [condition] },
    then: [{ type: 'show', targets: [block('short_text', 'target').id] }],
  };
  return previewVersion(formWith([source, block('short_text', 'target')], [rule]), { state: 'open' }, NOW);
}

describe('rule conditions the Logic tab writes', () => {
  it.each(sources.map((s) => [s.type, s] as const))('a new rule on a %s source compiles', (_type, source) => {
    const built = compiles(source, retarget('c1' as ConditionId, source, firstOperator(source, DEFAULTS), undefined, DEFAULTS));
    expect(built.ok ? [] : built.issues).toEqual([]);
  });

  it.each(sources.map((s) => [s.type, s] as const))('every operator a %s source offers compiles after a switch', (_type, source) => {
    let cond = retarget('c1' as ConditionId, source, firstOperator(source, DEFAULTS), undefined, DEFAULTS);
    for (const op of operatorsFor(source)) {
      cond = retarget(cond.id, source, op, cond.right, DEFAULTS);
      const built = compiles(source, cond);
      expect({ op, issues: built.ok ? [] : built.issues }).toEqual({ op, issues: [] });
    }
  });

  it('date and time sources start with a typed value, not a text one', () => {
    const date = block('date', 'when');
    const time = block('time', 'at');
    expect(retarget('c1' as ConditionId, date, firstOperator(date, DEFAULTS), undefined, DEFAULTS)).toMatchObject({ op: 'eq', right: { kind: 'literal', value: { type: 'date', value: '2026-10-18' } } });
    expect(retarget('c1' as ConditionId, time, firstOperator(time, DEFAULTS), undefined, DEFAULTS)).toMatchObject({ op: 'eq', right: { kind: 'literal', value: { type: 'time', value: '12:00' } } });
  });

  it('keeps a value that still fits the new operator and replaces one that does not', () => {
    const date = block('date', 'when');
    const typed: Operand = { kind: 'literal', value: { type: 'date', value: '2026-01-31' as IsoDate } };
    expect(retarget('c1' as ConditionId, date, 'before', typed, DEFAULTS).right).toEqual(typed);
    expect(retarget('c1' as ConditionId, date, 'after', text(''), DEFAULTS).right).toEqual({ kind: 'literal', value: { type: 'date', value: '2026-10-18' } });
    expect(retarget('c1' as ConditionId, date, 'is_answered', typed, DEFAULTS)).not.toHaveProperty('right');
  });

  it('localToday is the local calendar date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
