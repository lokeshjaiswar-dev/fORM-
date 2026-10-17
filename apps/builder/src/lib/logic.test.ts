import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LOGIC_OPERATORS, isBlockVisible, operatorNeedsValue } from '@/lib/logic';
import type { BlockLogic, LogicOperator } from '@/types/form';
import { block } from '@/test/fixtures';

const source = block('text', { id: 'src' });

function visible(logic: BlockLogic, answer: unknown) {
  const target = block('text', { id: 'target', logic: { enabled: true, sourceBlockId: 'src', ...logic } });
  return isBlockVisible(target, { src: answer }, [source, target]);
}

describe('operatorNeedsValue', () => {
  it('is false only for answered, not_answered and is_empty', () => {
    const noValue = LOGIC_OPERATORS.filter((o) => !operatorNeedsValue(o.value)).map((o) => o.value);
    expect(noValue).toEqual(['answered', 'not_answered', 'is_empty']);
  });

  it('defaults to true for a missing or unknown operator', () => {
    expect(operatorNeedsValue()).toBe(true);
    expect(operatorNeedsValue('bogus' as LogicOperator)).toBe(true);
  });
});

describe('isBlockVisible', () => {
  it('shows a block without logic, with disabled logic or without a source', () => {
    expect(isBlockVisible(block('text'), {}, [])).toBe(true);
    expect(isBlockVisible(block('text', { logic: { enabled: false, sourceBlockId: 'src', value: 'x' } }), {}, [])).toBe(true);
    expect(isBlockVisible(block('text', { logic: { enabled: true, value: 'x' } }), {}, [])).toBe(true);
  });

  it('defaults to show + equals', () => {
    expect(visible({ value: 'yes' }, 'yes')).toBe(true);
    expect(visible({ value: 'yes' }, 'no')).toBe(false);
  });

  it('equals trims the answer, is case-sensitive and compares a missing value with an empty string', () => {
    expect(visible({ operator: 'equals', value: 'yes' }, '  yes ')).toBe(true);
    expect(visible({ operator: 'equals', value: 'yes' }, 'Yes')).toBe(false);
    expect(visible({ operator: 'equals' }, undefined)).toBe(true);
    expect(visible({ operator: 'not_equals', value: 'yes' }, 'no')).toBe(true);
  });

  it('joins array answers with a space', () => {
    expect(visible({ operator: 'equals', value: 'a b' }, ['a', 'b'])).toBe(true);
    expect(visible({ operator: 'contains', value: 'b' }, ['a', 'b'])).toBe(true);
  });

  it('matches text operators case-insensitively', () => {
    expect(visible({ operator: 'contains', value: 'ELL' }, 'Hello')).toBe(true);
    expect(visible({ operator: 'not_contains', value: 'ELL' }, 'Hello')).toBe(false);
    expect(visible({ operator: 'starts_with', value: 'he' }, 'Hello')).toBe(true);
    expect(visible({ operator: 'ends_with', value: 'LO' }, 'Hello')).toBe(true);
  });

  it('compares numerically when both sides are numbers, otherwise as strings', () => {
    expect(visible({ operator: 'greater_than', value: '9' }, '10')).toBe(true);
    expect(visible({ operator: 'less_than', value: '9' }, '10')).toBe(false);
    expect(visible({ operator: 'greater_than', value: 'a' }, 'b')).toBe(true);
    expect(visible({ operator: 'greater_than', value: '-1' }, '')).toBe(true);
  });

  it('treats an empty or whitespace answer as unanswered', () => {
    expect(visible({ operator: 'answered' }, 'x')).toBe(true);
    expect(visible({ operator: 'answered' }, '   ')).toBe(false);
    expect(visible({ operator: 'not_answered' }, undefined)).toBe(true);
    expect(visible({ operator: 'is_empty' }, [])).toBe(true);
  });

  it('inverts the match for the hide action', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LOGIC_OPERATORS.map((o) => o.value)),
        fc.string(),
        fc.oneof(fc.string(), fc.array(fc.string()), fc.constant(undefined)),
        (operator, value, answer) => {
          expect(visible({ action: 'hide', operator, value }, answer)).toBe(!visible({ action: 'show', operator, value }, answer));
        },
      ),
    );
  });

  it.fails('B21: a rule whose source block was deleted is disabled', () => {
    const target = block('text', {
      id: 'target',
      logic: { enabled: true, action: 'show', sourceBlockId: 'deleted', operator: 'equals', value: 'yes' },
    });
    expect(isBlockVisible(target, {}, [target])).toBe(true);
  });
});
