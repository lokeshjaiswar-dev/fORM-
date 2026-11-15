import { describe, expect, it } from 'vitest';
import type { Answers, BlockId, FormDefinition } from '@form/schema';
import { displayRows } from './display-rows.ts';
import { draftWith, fieldBlock } from '../test/publishable-draft.ts';

const label = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });
const withLabel = (block: ReturnType<typeof fieldBlock>, text: string) => ({ ...block, label: label(text) });

const form = (): FormDefinition =>
  draftWith('0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10', [
    withLabel(fieldBlock('name', 'short_text'), 'Full name'),
    withLabel(fieldBlock('mail', 'email'), 'Email'),
    withLabel(fieldBlock('cv', 'file_upload'), 'CV'),
    withLabel(fieldBlock('age', 'number'), 'Age'),
  ]);

const a = (blockId: string, type: string, value: unknown) => ({ [blockId as BlockId]: { type, value } });

describe('displayRows', () => {
  it('builds a row per answered field, in the form’s order, from the form’s own labels and the answers’ text', () => {
    const file = { fileId: 'f1', name: 'cv.pdf', sizeBytes: 4, mime: 'application/pdf', sha256: 'a'.repeat(64), scan: 'skipped' };
    const values = { ...a('cv', 'file_upload', [file]), ...a('name', 'short_text', 'Asha'), ...a('mail', 'email', { address: 'asha@example.test' }) } as Answers;
    expect(displayRows(form(), values)).toEqual([
      { key: 'name', label: 'Full name', value: 'Asha' },
      { key: 'mail', label: 'Email', value: 'asha@example.test' },
      { key: 'cv', label: 'CV', value: 'cv.pdf' },
    ]);
  });

  it('has no row for a field without an answer, and none for an answer to a field the form does not have', () => {
    const values = { ...a('name', 'short_text', 'Asha'), ...a('approval', 'short_text', 'Yes - pay in full') } as Answers;
    expect(displayRows(form(), values)).toEqual([{ key: 'name', label: 'Full name', value: 'Asha' }]);
    expect(displayRows(form(), {} as Answers)).toEqual([]);
  });

  it('falls back to the key for an empty label, bounds long values, and makes control characters storable', () => {
    const definition = draftWith('0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10', [withLabel(fieldBlock('name', 'short_text'), '  '), withLabel(fieldBlock('note', 'short_text'), 'Note\u0000')]);
    const values = { ...a('name', 'short_text', 'x'.repeat(20_000)), ...a('note', 'short_text', 'a\u0007b') } as Answers;
    const rows = displayRows(definition, values);
    expect(rows[0]).toMatchObject({ key: 'name', label: 'name' });
    expect(rows[0]!.value).toHaveLength(10_000);
    expect(rows[1]).toEqual({ key: 'note', label: 'Note ', value: 'a b' });
  });
});
