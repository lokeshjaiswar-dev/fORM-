import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormPreview } from '@/components/preview/FormPreview';
import { block, resetStore } from '@/test/fixtures';
import type { FormBlock } from '@/types/form';
import { XSS_PAYLOADS } from '@form/schema/test-fixtures';

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

  it('B1: Next validates only the current page', async () => {
    const user = renderPreview([
      block('text', { id: 'a', label: 'First' }),
      block('page_break', { id: 'pb' }),
      block('text', { id: 'b', label: 'Second', validation: { required: true } }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it('B2: a hidden required field does not block submit', async () => {
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

  it('B1: a 3-page form with a required field on page 3 advances from page 1, then blocks on page 3', async () => {
    const user = renderPreview([
      block('text', { id: 'a', label: 'First' }),
      block('page_break', { id: 'pb1' }),
      block('text', { id: 'b', label: 'Second' }),
      block('page_break', { id: 'pb2' }),
      block('text', { id: 'c', label: 'Third', placeholder: 'Third answer', validation: { required: true } }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Third')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Third answer'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('B1: Next still blocks on an empty required field on the current page', async () => {
    const user = renderPreview([
      block('text', { id: 'a', label: 'First', validation: { required: true } }),
      block('page_break', { id: 'pb' }),
      block('text', { id: 'b', label: 'Second' }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('B2: a required field that becomes visible blocks submit', async () => {
    const user = renderPreview([
      block('text', { id: 'country', label: 'Country', placeholder: 'Country' }),
      block('text', {
        id: 'state',
        label: 'State',
        validation: { required: true },
        logic: { enabled: true, action: 'show', sourceBlockId: 'country', value: 'IN' },
      }),
    ]);
    await user.type(screen.getByPlaceholderText('Country'), 'IN');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('B4: a required empty signature blocks submit', async () => {
    const user = renderPreview([block('signature', { id: 'sig', label: 'Sign here', validation: { required: true } })]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Please sign')).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('B12: an invalid pattern is ignored instead of crashing', async () => {
    const user = renderPreview([block('text', { id: 'name', label: 'Name', placeholder: 'Name', validation: { pattern: '[' } })]);
    await user.type(screen.getByPlaceholderText('Name'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('S1/S2/S4: stored label HTML is rendered from the AST, never as HTML', () => {
    renderPreview([
      block('paragraph', { id: 'p', label: '<b>Bold</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a>' }),
      block('text', { id: 't', label: '<span style="color: red; position: fixed">Name</span><script>alert(1)</script>' }),
    ]);
    expect(document.querySelector('img, script')).toBeNull();
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText('bad')).not.toHaveAttribute('href');
    expect(screen.getByText('ok')).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByText('Name').getAttribute('style')).toBe('color: rgb(255, 0, 0);');
  });

  it('renders the XSS corpus as inert text and safe elements', () => {
    const types = ['paragraph', 'heading', 'text', 'heading_2'] as const;
    renderPreview(XSS_PAYLOADS.map((label, i) => block(types[i % types.length], { id: `b${i}`, label })));
    const elements = [...document.body.querySelectorAll('*')];
    expect(elements.flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => name.startsWith('on'))).toEqual([]);
    for (const a of document.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^(https?:\/\/|mailto:|tel:)/);
    const form = document.querySelector('form');
    expect(form?.textContent).toContain('docs');
    expect(form?.querySelector('script, img, iframe, svg, math, dialog, object, embed, style, form, base, meta, link, template')).toBeNull();
  }, 30_000);

  it('B28: rating and scale point counts are clamped', () => {
    renderPreview([
      block('rating', { id: 'r', label: 'Stars', customize: { ratingMax: 10_000_000 } }),
      block('linear_scale', { id: 's', label: 'Scale', customize: { scaleMin: 1, scaleMax: 1000 } }),
    ]);
    expect(screen.getByText('Stars').closest('div')!.querySelectorAll('svg')).toHaveLength(10);
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '11' })).not.toBeInTheDocument();
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
