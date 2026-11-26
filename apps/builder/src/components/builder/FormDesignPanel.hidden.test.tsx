import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { SHOWN_DESIGN_TABS } from '@/components/builder/design/shownTabs';
import { resetStore } from '@/test/fixtures';

beforeEach(() => resetStore());

/* FormDesignPanel.test.tsx covers these tabs with them shown; this checks the defaults the builder ships with. */
describe('Form settings tabs hidden for now', () => {
  it('hides Rules, Sections and API autofill', async () => {
    expect(Object.values(SHOWN_DESIGN_TABS).every((shown) => shown === false)).toBe(true);
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Themes', 'Colors', 'Layout', 'Submit']);
  });
});
