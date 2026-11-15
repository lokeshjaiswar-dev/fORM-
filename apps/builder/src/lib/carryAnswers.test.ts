import { describe, expect, it } from 'vitest';
import type { Answers, BlockId, PublicFormDefinition } from '@form/schema';
import { carryAnswers } from '@/lib/carryAnswers';
import { block, formWith } from '@/test/fixtures';

const def = (...blocks: ReturnType<typeof block>[]) => formWith(blocks) as unknown as PublicFormDefinition;
const text = (value: string) => ({ type: 'short_text' as const, value });

describe('carryAnswers', () => {
  it('moves an answer to the field of the new version that has the same key, whatever its block id is', () => {
    const from = def(block('short_text', 'name', { key: 'full_name' }), block('short_text', 'city', { key: 'city' }));
    const to = def(block('short_text', 'name_2', { key: 'full_name' }), block('short_text', 'town', { key: 'city' }));
    const answers: Answers = { ['name' as BlockId]: text('Asha'), ['city' as BlockId]: text('Pune') };
    expect(carryAnswers(from, to, answers)).toEqual({ name_2: text('Asha'), town: text('Pune') });
  });

  it('drops an answer whose field is gone, or is now another type', () => {
    const from = def(block('short_text', 'name', { key: 'name' }), block('short_text', 'age', { key: 'age' }), block('short_text', 'gone', { key: 'gone' }));
    const to = def(block('short_text', 'name', { key: 'name' }), block('number', 'age', { key: 'age' }));
    const answers: Answers = { ['name' as BlockId]: text('Asha'), ['age' as BlockId]: text('31'), ['gone' as BlockId]: text('x') };
    expect(carryAnswers(from, to, answers)).toEqual({ name: text('Asha') });
  });

  it('leaves out what the server makes (hidden fields, calculations) and answers to ids the old version never had', () => {
    const from = def(block('short_text', 'name', { key: 'name' }), block('hidden', 'src', { key: 'src' }));
    const to = def(block('short_text', 'name', { key: 'name' }), block('hidden', 'src', { key: 'src' }));
    const answers = { ['name' as BlockId]: text('Asha'), ['src' as BlockId]: { type: 'hidden', value: 'forged' }, ['__proto__' as BlockId]: text('x'), ['unknown' as BlockId]: text('y') } as unknown as Answers;
    expect(carryAnswers(from, to, answers)).toEqual({ name: text('Asha') });
  });

  it('carries nothing for a form with no answers', () => {
    const form = def(block('short_text', 'name', { key: 'name' }));
    expect(carryAnswers(form, form, {})).toEqual({});
  });
});
