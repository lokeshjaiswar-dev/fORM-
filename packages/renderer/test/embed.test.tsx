// @vitest-environment jsdom
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Answers, BlockId } from '@form/schema';
import { FormRenderer, type RendererHandle } from '../src/index.ts';
import { field, form, page, props, runtime } from './build.ts';

/* What an embedding host (the DMS+ upload step) gets: no navigation, answers as they change, an imperative validate. */

const def = () => form([field('short_text', 'name', { required: true }), field('short_text', 'city')], [page('p1', ['name', 'city'])]);

describe('embedding props', () => {
  it('hideNavigation: no Submit button, and Enter does not submit', async () => {
    const onSubmit = vi.fn();
    render(<FormRenderer {...props(runtime(def()), { onSubmit })} hideNavigation />);
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    await userEvent.setup().type(screen.getByRole('textbox', { name: /name/ }), 'Asha{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('without the props the form is unchanged: a Submit button that submits', async () => {
    const onSubmit = vi.fn();
    render(<FormRenderer {...props(runtime(def()), { onSubmit })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('onAnswersChange: not for the starting answers, then the evaluated answers after each edit', async () => {
    const seen: Answers[] = [];
    const initial: Answers = { ['city' as BlockId]: { type: 'short_text', value: 'Pune' } };
    render(<FormRenderer {...props(runtime(def()))} hideNavigation initialAnswers={initial} onAnswersChange={(a) => void seen.push(a)} />);
    expect(seen).toEqual([]);
    await userEvent.setup().type(screen.getByRole('textbox', { name: /name/ }), 'Al');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toMatchObject({ name: { type: 'short_text', value: 'Al' }, city: { type: 'short_text', value: 'Pune' } });
  });

  it('handleRef.validate: errors for the form, shown on the field, nothing submitted; valid once filled', async () => {
    const onSubmit = vi.fn();
    const handle = createRef<RendererHandle>();
    render(<FormRenderer {...props(runtime(def()), { onSubmit })} hideNavigation handleRef={handle} />);
    expect(handle.current).not.toBeNull();
    const errors = await handle.current!.validate();
    expect(errors.map((e) => [e.blockId, e.code])).toEqual([['name', 'required']]);
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    await userEvent.setup().type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    expect(await handle.current!.validate()).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('handleRef is cleared when the form unmounts', () => {
    const handle = createRef<RendererHandle>();
    const { unmount } = render(<FormRenderer {...props(runtime(def()))} hideNavigation handleRef={handle} />);
    unmount();
    expect(handle.current).toBeNull();
  });
});
