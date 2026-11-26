import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BlockId, OptionId } from '@form/schema';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { shownSettings } from '@/components/builder/inspector/shownSettings';
import { ProfileProvider } from '@/embed/profile';
import type { ProfileName } from '@/embed/launch';
import { useUiStore } from '@/state/uiStore';
import { block, resetStore } from '@/test/fixtures';

function open(id: string, profile: ProfileName) {
  useUiStore.getState().openInspector(id as BlockId);
  return render(
    <ProfileProvider profile={profile}>
      <BlockInspector />
    </ProfileProvider>,
  );
}

/* BlockInspector.test.tsx covers these settings in the full builder; this checks what the Masters builder (dms-v1) hides. */
describe('Block settings hidden in the Masters builder', () => {
  it('shows every setting in the full builder', () => {
    expect(Object.values(shownSettings('full')).every(Boolean)).toBe(true);
  });

  it('hides the pattern, API check, Advanced and Privacy, and keeps uniqueness (the primary key of a master)', () => {
    expect(shownSettings('dms-v1')).toMatchObject({ pattern: false, apiValidation: false, advanced: false, privacy: false, unique: true });
    resetStore([block('short_text', 'name')]);
    open('name', 'dms-v1');

    expect(screen.queryByRole('textbox', { name: 'Pattern (regular expression)' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Must be unique on this form' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Validate with an API' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Privacy' })).not.toBeInTheDocument();
  });

  it('hides the number display choice, so numbers stay plain inputs', () => {
    resetStore([block('number', 'age')]);
    open('age', 'dms-v1');

    expect(screen.getByRole('textbox', { name: 'Prefix' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Display' })).not.toBeInTheDocument();
  });

  it('hides Display and More options on a dropdown, but not on a radio list', () => {
    const options = [{ id: 'a' as OptionId, label: 'A' }];
    resetStore([block('single_choice', 'pick', { config: { display: 'dropdown', options } }), block('single_choice', 'radio', { config: { display: 'radio', options } })]);
    const { unmount } = open('pick', 'dms-v1');

    expect(screen.getByRole('button', { name: /Add option/ })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Display' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More options/i })).not.toBeInTheDocument();
    unmount();

    open('radio', 'dms-v1');
    expect(screen.getByRole('combobox', { name: 'Display' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More options/i })).toBeInTheDocument();
  });
});
