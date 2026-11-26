import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { shownDesignTabs } from '@/components/builder/design/shownTabs';
import { ProfileProvider } from '@/embed/profile';
import { resetStore } from '@/test/fixtures';

beforeEach(() => resetStore());

/* FormDesignPanel.test.tsx covers every tab in the full builder; this checks what the Masters builder (dms-v1) hides. */
describe('Form settings tabs in the Masters builder', () => {
  it('hides Rules and Sections, and keeps Fill from master', async () => {
    expect(shownDesignTabs('dms-v1')).toEqual({ logic: false, sections: false, lookup: true });
    expect(Object.values(shownDesignTabs('full')).every(Boolean)).toBe(true);
    const user = userEvent.setup();
    render(
      <ProfileProvider profile="dms-v1">
        <FormDesignPanel />
      </ProfileProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toContain('Themes');
    expect(tabs).toContain('Fill from master');
    expect(tabs).not.toContain('Rules');
    expect(tabs).not.toContain('Sections');
  });
});
