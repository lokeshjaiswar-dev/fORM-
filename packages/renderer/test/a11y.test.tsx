// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FormRenderer } from '../src/index.ts';
import { corpus, kitchenSink, props, rich, runtime } from './build.ts';

/*
 * Accessibility baseline (WP-0.10): axe reports no serious or critical violation on any fixture, on a page with
 * errors and on the ending. jsdom has no layout, so colour contrast is left to the Chromium e2e run in the builder.
 */

async function violations(root: Element) {
  const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.html) }));
}

describe('axe', () => {
  it.each([...corpus(), { name: 'kitchen sink', version: runtime(kitchenSink()) }])('$name has no serious or critical violations', async ({ version }) => {
    const { container } = render(<FormRenderer {...props(version)} />);
    expect(await violations(container)).toEqual([]);
  });

  it('the kitchen sink second page, with errors shown, has none', async () => {
    const { container } = render(<FormRenderer {...props(runtime(kitchenSink()))} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findAllByText('This field is required.');
    expect(await violations(container)).toEqual([]);
    await user.type(screen.getByRole('textbox', { name: /short_text question/ }), 'Asha');
    await user.type(screen.getByRole('textbox', { name: /email question/ }), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('radiogroup', { name: /rating question/ });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findAllByText('This field is required.');
    expect(await violations(container)).toEqual([]);
  });

  it('status and ending screens have none', async () => {
    const closed = render(<FormRenderer {...props(runtime(kitchenSink(), { state: 'closed', screen: rich('Closed.') }))} />);
    expect(await violations(closed.container)).toEqual([]);
    closed.unmount();
    const password = render(<FormRenderer {...props(runtime(kitchenSink(), { state: 'password', screen: { type: 'doc', content: [] } }))} />);
    expect(await violations(password.container)).toEqual([]);
    password.unmount();
    const def = kitchenSink();
    const simple = { ...def, pages: [{ id: def.pages[0]!.id, children: ['title' as never] }] };
    const { container } = render(<FormRenderer {...props(runtime(simple))} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Thanks for your response!' })).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('finds a violation it should (sensitivity check)', async () => {
    const { container } = render(<div><img src="x.png" /><button type="button" /></div>);
    expect((await violations(container)).map((v) => v.id).sort()).toEqual(['button-name', 'image-alt']);
  });
});
