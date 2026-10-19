import { describe, expect, it, vi } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { newStoredForm, openStored } from '@/persistence/openForm';
import { block, formWith } from '@/test/fixtures';

vi.mock('@/lib/preview', () => ({
  migrateForBuilder: () => {
    throw new Error('boom');
  },
}));

const NOW = '2026-10-18T00:00:00.000Z';

describe('openStored when the migration throws', () => {
  it('still opens the v1 draft, with one note saying the migration failed', () => {
    const opened = openStored({ ...newStoredForm('abc', NOW), doc: formWith([block('text', { id: 'q', label: 'Q' })]) }, NOW as IsoInstant);
    expect(opened).toMatchObject({ ok: true, doc: { id: 'abc', blocks: [{ id: 'q' }] } });
    expect(opened.ok && opened.notes).toEqual([{ code: 'migration_failed', path: '', detail: expect.stringContaining('boom') }]);
  });
});
