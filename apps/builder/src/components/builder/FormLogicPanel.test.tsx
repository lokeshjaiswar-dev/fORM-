import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Condition, OptionId } from '@form/schema';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { FormPreview } from '@/components/preview/PreviewPane';
import { block, doc, resetStore } from '@/test/fixtures';

const stateGstin = () => [
  block('single_choice', 'state', {
    label: 'State',
    config: {
      display: 'dropdown',
      options: [
        { id: 'mh' as OptionId, label: 'Maharashtra', code: '27' },
        { id: 'ka' as OptionId, label: 'Karnataka', code: '29' },
        { id: 'goa' as OptionId, label: 'Goa' },
      ],
    },
  }),
  block('short_text', 'gstin', { label: 'GSTIN' }),
  block('short_text', 'note', { label: 'Note' }),
];

async function pick(user: ReturnType<typeof userEvent.setup>, combobox: HTMLElement, option: string) {
  await user.click(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => resetStore(stateGstin()));

describe('Form settings Logic', () => {
  it('"Add a rule" opens an empty draft and writes nothing until a question is chosen', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    await user.click(screen.getByText('Add a rule'));
    expect(doc().logic.rules).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Cancel new rule' })).toBeInTheDocument();
  });

  it('blocks preview submit when GSTIN does not start with the state code, allows a match and a state with no code (review S2)', async () => {
    const user = userEvent.setup();
    const panel = render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    await user.click(screen.getByText('Add a rule'));
    await pick(user, screen.getByRole('combobox', { name: 'Question' }), 'GSTIN');
    await pick(user, screen.getByRole('combobox', { name: 'Condition' }), 'does not start with');
    await pick(user, screen.getByRole('combobox', { name: 'Then' }), 'Show error');
    await pick(user, screen.getAllByRole('combobox', { name: 'Field' })[0]!, 'GSTIN');
    const rule = doc().logic.rules[0];
    expect((rule?.when.children[0] as Condition).op).toBe('not_starts_with');
    expect(rule?.then).toEqual([expect.objectContaining({ type: 'block_submit', anchorBlockId: 'gstin' })]);
    panel.unmount();
    const preview = render(<FormPreview />);
    await user.selectOptions(screen.getByRole('combobox', { name: /State/ }), 'Maharashtra');
    const gstin = screen.getByRole('textbox', { name: /GSTIN/ });
    await user.type(gstin, '29AAAAA0000A1Z5');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('This answer does not match.')).toBeInTheDocument();
    await user.clear(gstin);
    await user.type(gstin, '27AAAAA0000A1Z5');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
    preview.unmount();
    /* A state without a code has nothing to match: as on dev, the check does not hold the form back. */
    render(<FormPreview />);
    await user.selectOptions(screen.getByRole('combobox', { name: /State/ }), 'Goa');
    await user.type(screen.getByRole('textbox', { name: /GSTIN/ }), '30AAAAA0000A1Z5');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
  });
});
