import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormPreview } from '@/components/preview/FormPreview';
import { block, resetStore } from '@/test/fixtures';
import type { FormBlock } from '@/types/form';

function renderPreview(blocks: FormBlock[]) {
  resetStore(blocks);
  render(<FormPreview />);
  return userEvent.setup();
}

const thanks = 'Thanks for your response!';

beforeEach(() => resetStore());

describe('FormPreview', () => {
  it('submits a filled form and shows the thank-you screen', async () => {
    const user = renderPreview([block('text', { id: 'name', label: 'Name', placeholder: 'Your name', validation: { required: true } })]);
    await user.type(screen.getByPlaceholderText('Your name'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('shows Required and stays on the form when a required field is empty', async () => {
    const user = renderPreview([block('text', { id: 'name', label: 'Name', validation: { required: true } })]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('pages on page breaks with Next and Back', async () => {
    const user = renderPreview([block('text', { id: 'a', label: 'First' }), block('page_break', { id: 'pb' }), block('text', { id: 'b', label: 'Second' })]);
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('First')).toBeInTheDocument();
  });

  it('hides a block until its show rule matches', async () => {
    const user = renderPreview([
      block('text', { id: 'country', label: 'Country', placeholder: 'Country' }),
      block('text', { id: 'state', label: 'State', logic: { enabled: true, action: 'show', sourceBlockId: 'country', value: 'IN' } }),
    ]);
    expect(screen.queryByText('State')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Country'), 'IN');
    expect(await screen.findByText('State')).toBeInTheDocument();
  });

  it.fails('B1: Next validates only the current page', async () => {
    const user = renderPreview([
      block('text', { id: 'a', label: 'First' }),
      block('page_break', { id: 'pb' }),
      block('text', { id: 'b', label: 'Second', validation: { required: true } }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it.fails('B2: a hidden required field does not block submit', async () => {
    const user = renderPreview([
      block('text', { id: 'country', label: 'Country' }),
      block('text', {
        id: 'state',
        label: 'State',
        validation: { required: true },
        logic: { enabled: true, action: 'show', sourceBlockId: 'country', value: 'IN' },
      }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it.fails('B7: an unanswered NPS shows no score selected', () => {
    renderPreview([block('nps', { id: 'nps', label: 'Recommend?' })]);
    expect(screen.getByRole('button', { name: '0' })).not.toHaveAttribute('style');
  });

  it.fails('B7: an unanswered linear scale starting at 0 shows nothing selected', () => {
    renderPreview([block('linear_scale', { id: 'scale', label: 'Scale', customize: { scaleMin: 0, scaleMax: 5 } })]);
    expect(screen.getByRole('button', { name: '0' })).not.toHaveAttribute('style');
  });
});
