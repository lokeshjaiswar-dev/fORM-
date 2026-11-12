import { describe, expect, it } from 'vitest';
import { FormDefinitionSchema } from '@form/schema';
import { mergeLoaded } from '@/lib/mergeSelected';
import { block, formWith } from '@/test/fixtures';

describe('mergeLoaded', () => {
  it('merges two local drafts and opens a new stored form', () => {
    const a = formWith([block('short_text', 'n1', { label: 'City', config: { maxLength: 40 } })]);
    const b = formWith([block('email', 'e1', { label: 'Email' })]);
    const result = mergeLoaded([
      { id: 'a', title: 'One', definition: a },
      { id: 'b', title: 'Two', definition: b },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.doc).toMatchObject({ title: 'One + Two' });
    const parsed = FormDefinitionSchema.safeParse(result.form.doc);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('keeps a schema-valid document when two short_text fields match', () => {
    const a = formWith([block('short_text', 'q', { label: 'Question' })]);
    const b = formWith([block('short_text', 'q', { label: 'Question' })]);
    const result = mergeLoaded([
      { id: 'one', title: 'Alpha', definition: a },
      { id: 'two', title: 'Beta', definition: b },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = FormDefinitionSchema.safeParse(result.form.doc);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('returns conflicts so the user can pick a side', () => {
    const a = formWith([block('short_text', 'n1', { label: 'Code', config: { pattern: { source: '^[A-Z]+$' } } })]);
    const b = formWith([block('short_text', 'n2', { label: 'Code', config: { pattern: { source: '^[0-9]+$' } } })]);
    const blocked = mergeLoaded([
      { id: 'a', title: 'One', definition: a },
      { id: 'b', title: 'Two', definition: b },
    ]);
    expect(blocked.ok).toBe(false);
    if (blocked.ok || !('conflicts' in blocked)) return;
    const ok = mergeLoaded(
      [
        { id: 'a', title: 'One', definition: a },
        { id: 'b', title: 'Two', definition: b },
      ],
      [{ label: 'Code', type: 'short_text', chosenFormId: 'a' }],
    );
    expect(ok.ok).toBe(true);
  });
});
