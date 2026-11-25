import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BlockId } from '@form/schema';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { ProfileProvider } from '@/embed/profile';
import { useUiStore } from '@/state/uiStore';
import { block, resetStore } from '@/test/fixtures';

const legacy = { 'x-dms': { type: 'multilineinput', legacy: { from: 'files', readOnly: true } } };

function open(id: string, profile: 'dms-v1' | 'full') {
  useUiStore.getState().openInspector(id as BlockId);
  render(
    <ProfileProvider profile={profile}>
      <BlockInspector />
    </ProfileProvider>,
  );
}

beforeEach(() => {
  resetStore([block('long_text', 'docs', { label: 'Docs', x: legacy }), block('long_text', 'plain', { label: 'Plain', x: { 'x-dms': { type: 'multilineinput' } } })]);
});

describe('BlockInspector in profile dms-v1: legacy read-only blocks', () => {
  it('shows only General with a locked notice: no Options or Validation tab, no settings', () => {
    open('docs', 'dms-v1');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General']);
    expect(screen.getByRole('note')).toHaveTextContent(/converted from an OpenForm "files" field.*locked/);
    expect(screen.queryByRole('textbox', { name: 'Field key' })).toBeNull();
    expect(screen.queryByText('Required')).toBeNull();
  });

  it('a normal block keeps its tabs', () => {
    open('plain', 'dms-v1');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toContain('Validation');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('outside profile dms-v1 the marker locks nothing', () => {
    open('docs', 'full');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toContain('Validation');
    expect(screen.queryByRole('note')).toBeNull();
  });
});
