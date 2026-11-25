// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BlockId, EndingId, RichDoc } from '@form/schema';
import { FormRenderer, type SubmitHandler } from '../src/index.ts';
import { field, form, id, page, props, runtime } from './build.ts';

/* The server issues unique_id values on submit; the form only shows a preview from prefix + startAt. */

const REF = id<BlockId>('ref');

function serialForm() {
  const thanks: RichDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ticket ' },
          { type: 'pipe', attrs: { source: { kind: 'answer', blockId: REF } } },
        ],
      },
    ],
  };
  return form(
    [field('short_text', 'name'), field('unique_id', 'ref', { config: { prefix: ['T-'], padTo: 3, startAt: 1, resetEvery: 'never', showOnEnding: true } })],
    [page('p1', ['name', 'ref'])],
    [],
    { endings: [{ id: id<EndingId>('ending_1'), kind: 'message', name: 'Thanks', content: thanks, actions: [] }] },
  );
}

describe('unique_id on the ending', () => {
  it('shows the value the server issued, not the preview', async () => {
    const onSubmit: SubmitHandler = () => ({ ok: true, uniqueId: 'T-042', uniqueIds: { ref: 'T-042' } });
    render(<FormRenderer {...props(runtime(serialForm()), { onSubmit })} />);
    expect(screen.getByText('T-001', { selector: 'output' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Your reference number:')).toBeInTheDocument();
    expect(screen.getByText('T-042', { selector: 'strong' })).toBeInTheDocument();
    // A pipe of the field in the ending content reads the issued value too.
    expect(screen.getByRole('heading', { name: 'Ticket T-042' })).toBeInTheDocument();
  });

  it('shows no reference when the host issued none', async () => {
    render(<FormRenderer {...props(runtime(serialForm()), { onSubmit: () => undefined })} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('heading', { name: 'Ticket T-001' })).toBeInTheDocument();
    expect(screen.queryByText('Your reference number:')).not.toBeInTheDocument();
  });
});
