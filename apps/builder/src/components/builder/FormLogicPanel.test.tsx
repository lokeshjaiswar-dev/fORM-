import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OptionId } from '@form/schema';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { block, doc, resetStore } from '@/test/fixtures';

const stateGstin = () => [
  block('single_choice', 'state', {
    label: 'State',
    config: {
      display: 'dropdown',
      options: [
        { id: 'mh' as OptionId, label: 'Maharashtra', code: '27' },
        { id: 'ka' as OptionId, label: 'Karnataka', code: '29' },
      ],
    },
  }),
  block('short_text', 'gstin', { label: 'GSTIN' }),
];

beforeEach(() => resetStore(stateGstin()));

describe('Form settings Logic', () => {
  it('"Add a rule" opens an empty draft and writes nothing until a question is chosen', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    screen.debug(undefined, 4000); await user.click(screen.getByText('Add a rule'));
    expect(doc().logic.rules).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Cancel new rule' })).toBeInTheDocument();
  });
});
