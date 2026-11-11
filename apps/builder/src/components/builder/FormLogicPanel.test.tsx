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
      ],
    },
  }),
  block('short_text', 'gstin', { label: 'GSTIN' }),
];

beforeEach(() => resetStore(stateGstin()));

describe('Form settings Logic', () => {
  it('adds a GSTIN vs State check from Form settings', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a check' }));
    const rule = doc().logic.rules[0];
    expect(rule?.then[0]).toMatchObject({ type: 'block_submit', anchorBlockId: 'gstin' });
    const ops = (rule?.when.children as Condition[]).map((c) => c.op);
    expect(ops).toEqual(['is_answered', 'is_answered', 'not_starts_with']);
    expect((rule?.when.children as Condition[])[2]?.right).toEqual({ kind: 'ref', ref: { kind: 'answer', blockId: 'state' } });
  });

  it('blocks preview submit when GSTIN does not match the state code, and allows a match', async () => {
    const user = userEvent.setup();
    const panel = render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a check' }));
    panel.unmount();
    render(<FormPreview />);
    fireEvent.change(screen.getByRole('combobox', { name: /State/ }), { target: { value: 'mh' } });
    const gstin = screen.getByRole('textbox', { name: /GSTIN/ });
    await user.type(gstin, '29AAAAA0000A1Z5');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('This answer does not match.')).toBeInTheDocument();
    await user.clear(gstin);
    await user.type(gstin, '27AAAAA0000A1Z5');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
  });
});
