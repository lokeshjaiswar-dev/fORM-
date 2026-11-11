import { describe, expect, it } from 'vitest';
import type { Answers, BlockId, CardBucketId, CardItemId, MatchingPromptId, OptionId } from '@form/schema';
import { answerRows } from '@/persistence/answerRows';
import { block, formWith } from '@/test/fixtures';

describe('answerRows', () => {
  it('pairs field labels with submitted values in page order', () => {
    const definition = formWith([
      block('short_text', 'name', { label: 'Name' }),
      block('email', 'mail', { label: 'Email' }),
    ]);
    expect(
      answerRows(definition, {
        ['name' as BlockId]: { type: 'short_text', value: 'Asha' },
        ['mail' as BlockId]: { type: 'email', value: { address: 'asha@example.com' } },
      } as Answers),
    ).toEqual([
      { key: 'name', label: 'Name', value: 'Asha' },
      { key: 'mail', label: 'Email', value: 'asha@example.com' },
    ]);
  });

  it('shows choice labels instead of option ids', () => {
    const definition = formWith([
      block('single_choice', 'color', {
        label: 'Colour',
        config: { display: 'radio', options: [{ id: 'red' as OptionId, label: 'Red' }, { id: 'blue' as OptionId, label: 'Blue' }] },
      }),
    ]);
    expect(
      answerRows(definition, {
        ['color' as BlockId]: { type: 'single_choice', value: { optionId: 'red' as OptionId } },
      } as Answers),
    ).toEqual([{ key: 'color', label: 'Colour', value: 'Red' }]);
  });

  it('shows matching and card sort as label - value lines', () => {
    const definition = formWith([
      block('matching', 'pair', { label: 'Sounds' }),
      block('card_sort', 'sort', { label: 'Work', config: { exclusive: false } }),
    ]);
    const rows = answerRows(definition, {
      ['pair' as BlockId]: { type: 'matching', value: { ['prompt_1' as MatchingPromptId]: 'option_1' as OptionId, ['prompt_2' as MatchingPromptId]: 'option_2' as OptionId, ['prompt_3' as MatchingPromptId]: 'option_3' as OptionId } },
      ['sort' as BlockId]: { type: 'card_sort', value: { ['item_1' as CardItemId]: ['bucket_1' as CardBucketId, 'bucket_2' as CardBucketId], ['item_2' as CardItemId]: 'bucket_2' as CardBucketId } },
    } as Answers);
    expect(rows[0]?.value).toContain(' - ');
    expect(rows[1]?.value).toMatch(/ - /);
  });
});
