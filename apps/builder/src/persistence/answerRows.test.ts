import { describe, expect, it } from 'vitest';
import type { Answers, BlockId } from '@form/schema';
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
});
