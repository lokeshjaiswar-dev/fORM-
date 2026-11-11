// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import { FormRenderer } from '../src/index.ts';
import { EN_IN, field, form, page, props, runtime } from './build.ts';

describe('matrix single-select', () => {
  it('keeps one column per row when multiple columns are clicked', async () => {
    const defaults = REGISTRY.matrix.defaultConfig(EN_IN);
    const block = field('matrix', 'q', {
      config: {
        mode: 'single',
        columns: defaults.columns.map((col) => ({ ...col, input: 'choice' as const })),
      },
    });
    render(<FormRenderer {...props(runtime(form([block], [page('p1', ['q'])])))} />);
    const user = userEvent.setup();
    const row = screen.getByRole('row', { name: /Row 1/i });
    const radios = within(row).getAllByRole('radio');
    expect(radios.length).toBeGreaterThanOrEqual(2);
    await user.click(radios[0]!);
    await user.click(radios[1]!);
    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeChecked();
    expect(within(row).getAllByRole('radio', { checked: true })).toHaveLength(1);
    expect(radios[1]).toHaveAttribute('value', 'column_2');
  });
});
