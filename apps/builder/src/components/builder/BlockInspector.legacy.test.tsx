import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BlockId, OptionId } from '@form/schema';
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

  it('a normal block keeps its tabs (General and Design; DMS forms have no Logic)', () => {
    open('plain', 'dms-v1');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Design']);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a DMS master dropdown offers the cascading link (stored as linkedTo/optionParents), and no field shows the Privacy section', () => {
    resetStore([
      block('single_choice', 'country', { label: 'Country', config: { display: 'dropdown', options: [{ id: 'in' as OptionId, label: 'India' }] } }),
      block('single_choice', 'state', { label: 'State', config: { display: 'dropdown', options: [{ id: 's1' as OptionId, label: 'Goa' }] } }),
    ]);
    open('state', 'dms-v1');
    expect(screen.getByRole('button', { name: 'Add option' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Link to an earlier question' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Privacy' })).toBeNull();
    cleanup();
    open('state', 'full');
    expect(screen.getByRole('switch', { name: 'Link to an earlier question' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy' })).toBeInTheDocument();
  });

  it('outside profile dms-v1 the marker locks nothing', () => {
    open('docs', 'full');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Design', 'Logic']);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
