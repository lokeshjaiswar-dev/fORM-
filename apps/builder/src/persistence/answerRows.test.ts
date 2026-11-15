import { describe, expect, it } from 'vitest';
import type { Answers, BlockId, CardBucketId, CardItemId, MatchingPromptId, OptionId } from '@form/schema';
import { answerRows, readableFields } from '@/persistence/answerRows';
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

  it('shows appointments as a date and clock range, not raw instants', () => {
    const definition = formWith([block('appointment', 'visit', { label: 'Appointment name' })]);
    const rows = answerRows(definition, {
      ['visit' as BlockId]: {
        type: 'appointment',
        value: { start: '2026-11-10T03:30:00Z', end: '2026-11-10T04:00:00Z', respondentTimeZone: 'Asia/Kolkata' },
      },
    } as Answers);
    expect(rows[0]?.value).toMatch(/10 Nov 2026/);
    expect(rows[0]?.value).toMatch(/9:00/);
    expect(rows[0]?.value).not.toContain('2026-11-10T03:30:00Z');
  });
});

describe('readableFields', () => {
  const definition = () => formWith([block('short_text', 'name', { label: 'Name' }), block('file_upload', 'cv', { label: 'CV' })]);
  const file = { fileId: '0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10', name: 'cv.pdf', sizeBytes: 4, mime: 'application/pdf', sha256: 'a'.repeat(64), scan: 'skipped' };
  const answers = {
    ['name' as BlockId]: { type: 'short_text', value: 'Asha' },
    ['cv' as BlockId]: { type: 'file_upload', value: [file] },
  } as Answers;

  it('shows a response from the API by the rows the server built, with files matched in from the answers', () => {
    const rows = readableFields(definition(), {
      source: 'server',
      answers,
      // The server's own rows: its labels, not the form's current ones.
      fields: [
        { key: 'name', label: 'Full name', value: 'Asha' },
        { key: 'cv', label: 'CV', value: 'cv.pdf' },
      ],
    });
    expect(rows.map((r) => [r.key, r.label, r.value])).toEqual([
      ['name', 'Full name', 'Asha'],
      ['cv', 'CV', 'cv.pdf'],
    ]);
    expect(rows[1]?.media).toEqual([{ fileId: file.fileId, name: 'cv.pdf', mime: 'application/pdf' }]);
    expect(rows[0]).not.toHaveProperty('media');
  });

  it('adds no line of its own to a server response, even when the answers could be rebuilt into one', () => {
    const rows = readableFields(definition(), { source: 'server', answers, fields: [{ key: 'name', label: 'Name', value: 'Asha' }] });
    expect(rows.map((r) => r.key)).toEqual(['name']);
  });

  it('shows a server response without the form from its rows alone', () => {
    expect(readableFields(null, { source: 'server', answers, fields: [{ key: 'name', label: 'Name', value: 'Asha' }] })).toEqual([{ key: 'name', label: 'Name', value: 'Asha' }]);
  });

  it('still rebuilds a preview response made in this browser from the form, so its labels stay current', () => {
    const rows = readableFields(definition(), { answers, fields: [{ key: 'name', label: 'Old label', value: 'Asha' }] });
    expect(rows.map((r) => r.label)).toEqual(['Name', 'CV']);
  });
});
