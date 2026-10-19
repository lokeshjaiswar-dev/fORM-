import { describe, expect, it, vi } from 'vitest';
import type { IsoInstant } from '@form/schema';
import { LEGACY_FORMAT } from '@/persistence/DocumentRepository';
import { openStored } from '@/persistence/openForm';
import { v1Form } from '@/test/fixtures';

vi.mock('@/lib/migrate', async (original) => ({
  ...(await original<typeof import('@/lib/migrate')>()),
  migrateDraft: () => {
    throw new Error('boom');
  },
}));

const NOW = '2026-10-18T00:00:00.000Z';

describe('openStored when the migration throws', () => {
  it('refuses the v1 draft with the reason instead of opening a half-converted form; the stored draft is untouched', () => {
    const doc = v1Form([{ id: 'q', type: 'text', label: 'Q' }]);
    const opened = openStored({ id: 'abc', format: LEGACY_FORMAT, rev: 1, savedAt: NOW, doc }, NOW as IsoInstant);
    expect(opened).toEqual({ ok: false, error: expect.stringContaining('boom') });
    expect(doc.blocks).toHaveLength(1);
  });
});
