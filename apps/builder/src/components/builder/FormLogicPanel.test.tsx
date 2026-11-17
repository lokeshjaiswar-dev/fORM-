import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Condition, OptionId } from '@form/schema';
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
  it('adds a GSTIN vs State check from Form settings', async () => {
    const user = userEvent.setup();
    render(<FormDesignPanel />);
    await user.click(screen.getByRole('button', { name: 'Form settings' }));
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    const rule = doc().logic.rules[0];
    expect(rule?.then[0]).toMatchObject({ type: 'show', targets: ['state'] });
    expect(rule?.else?.[0]).toMatchObject({ type: 'hide', targets: ['state'] });
    const [only] = rule?.when.children as Condition[];
    expect(only?.op).toBe('eq');
    expect(only?.left).toMatchObject({ kind: 'expr', expr: { k: 'call', fn: 'option_code' } });
    expect(only?.right).toMatchObject({ kind: 'ref', ref: { kind: 'answer', blockId: 'gstin' } });
  });
});
