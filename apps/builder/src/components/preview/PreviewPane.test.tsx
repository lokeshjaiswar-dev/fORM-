import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { REGISTRY } from '@form/registry';
import { fromHtml, fromHtmlInline, type StoredBlock } from '@form/schema';
import { XSS_PAYLOADS } from '@form/schema/test-fixtures';
import { FormPreview, PreviewPane } from '@/components/preview/PreviewPane';
import { updateOps } from '@/state/opsStore';
import { richDoc } from '@/lib/definition';
import { block, formWith, resetStore, rule, text } from '@/test/fixtures';

const thanks = 'Thanks for your response!';
const required = 'This field is required.';

function renderPreview(pages: StoredBlock[] | StoredBlock[][], rules = [] as Parameters<typeof resetStore>[1]) {
  resetStore(pages, rules);
  render(<FormPreview />);
  return userEvent.setup();
}

beforeEach(() => resetStore());

describe('PreviewPane', () => {
  it('renders the compiled draft in the device frame and switches devices', async () => {
    render(<PreviewPane definition={formWith([block('short_text', 'name', { label: 'Name' })])} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('unlocks a password-protected form only with its password (local FormOps, S5)', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    const user = renderPreview([block('short_text', 'name', { label: 'Name' })]);
    act(() => updateOps({ password: 'hunter2' }));
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(error).toHaveBeenCalledWith('Incorrect password');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('shows the closed screen of a closed form', () => {
    renderPreview([block('short_text', 'name', { label: 'Name' })]);
    act(() => updateOps({ open: false, closedMessage: richDoc('Registrations are closed.') }));
    expect(screen.getByRole('heading', { name: 'Registrations are closed.' })).toBeInTheDocument();
  });

  it('lists the issues when the engine refuses the draft', () => {
    const definition = formWith([block('short_text', 'name', { label: 'Name' })]);
    const page = definition.pages[0]!;
    const broken = { ...definition, blocks: { ...definition.blocks, grid: { id: 'grid', type: 'image', config: REGISTRY.image.defaultConfig('en-IN' as never) } as never }, pages: [{ ...page, children: [...page.children, 'grid' as never] }] };
    render(<PreviewPane definition={broken} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This form cannot be previewed yet.');
  });

  it('BL-134: a redirect ending is shown, not followed', async () => {
    const definition = formWith([block('short_text', 'name', { label: 'Name', required: true })]);
    const redirect = { id: 'go' as never, kind: 'redirect' as const, name: 'Redirect', url: ['https://example.com/next'] };
    const href = window.location.href;
    render(<PreviewPane definition={{ ...definition, endings: [...definition.endings, redirect], defaultEndingId: redirect.id }} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(/After submit, respondents go to https:\/\/example.com\/next/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in a new tab/ })).toHaveAttribute('target', '_blank');
    expect(window.location.href).toBe(href);
  });
});

/* The bug tests the v1 FormPreview carried, now on the v2 path: store definition → compile → @form/renderer. */
describe('FormPreview (v2 store → compile → renderer)', () => {
  it('submits a filled form and shows the thank-you screen', async () => {
    const user = renderPreview([block('short_text', 'name', { label: 'Name', required: true, config: { placeholder: 'Your name' } })]);
    await user.type(screen.getByPlaceholderText('Your name'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('shows Required and stays on the form when a required field is empty', async () => {
    const user = renderPreview([block('short_text', 'name', { label: 'Name', required: true })]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(required)).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('pages with Next and Back', async () => {
    const user = renderPreview([[block('short_text', 'a', { label: 'First' })], [block('short_text', 'b', { label: 'Second' })]]);
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('First')).toBeInTheDocument();
  });

  it('hides a block until its show rule matches', async () => {
    const user = renderPreview(
      [block('short_text', 'country', { label: 'Country', config: { placeholder: 'Country' } }), block('short_text', 'state', { label: 'State', initiallyHidden: true })],
      [rule('r1', 'country', 'eq', text('IN'), 'show', ['state'])],
    );
    expect(screen.queryByText('State')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Country'), 'IN');
    expect(await screen.findByText('State')).toBeInTheDocument();
  });

  it('B1: Next validates only the current page', async () => {
    const user = renderPreview([[block('short_text', 'a', { label: 'First' })], [block('short_text', 'b', { label: 'Second', required: true })]]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it('B1: a 3-page form with a required field on page 3 advances from page 1, then blocks on page 3', async () => {
    const user = renderPreview([
      [block('short_text', 'a', { label: 'First' })],
      [block('short_text', 'b', { label: 'Second' })],
      [block('short_text', 'c', { label: 'Third', required: true, config: { placeholder: 'Third answer' } })],
    ]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.queryByText(required)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Third')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(required)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Third answer'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('B1: Next still blocks on an empty required field on the current page', async () => {
    const user = renderPreview([[block('short_text', 'a', { label: 'First', required: true })], [block('short_text', 'b', { label: 'Second' })]]);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(required)).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('B2: a hidden required field does not block submit', async () => {
    const user = renderPreview(
      [block('short_text', 'country', { label: 'Country' }), block('short_text', 'state', { label: 'State', required: true, initiallyHidden: true })],
      [rule('r1', 'country', 'eq', text('IN'), 'show', ['state'])],
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('B2: a required field that becomes visible blocks submit', async () => {
    const user = renderPreview(
      [block('short_text', 'country', { label: 'Country', config: { placeholder: 'Country' } }), block('short_text', 'state', { label: 'State', required: true, initiallyHidden: true })],
      [rule('r1', 'country', 'eq', text('IN'), 'show', ['state'])],
    );
    await user.type(screen.getByPlaceholderText('Country'), 'IN');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(required)).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('B4: a required empty signature blocks submit', async () => {
    const user = renderPreview([block('signature', 'sig', { label: 'Sign here', required: true })]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(required)).toBeInTheDocument();
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();
  });

  it('B12: an invalid pattern is ignored by the preview, which still submits', async () => {
    const user = renderPreview([block('short_text', 'name', { label: 'Name', config: { placeholder: 'Name', pattern: { source: '[' } } })]);
    expect(screen.queryByText('This form cannot be previewed yet.')).toBeNull();
    await user.type(screen.getByPlaceholderText('Name'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText(thanks)).toBeInTheDocument();
  });

  it('S1/S2/S4: labels from HTML are an AST rendered as elements, never as HTML', () => {
    renderPreview([
      block('paragraph', 'p', { config: { content: fromHtml('<b>Bold</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a>').doc } }),
      block('short_text', 't', { label: fromHtmlInline('<span style="color: red; position: fixed">Name</span><script>alert(1)</script>').doc }),
    ]);
    expect(document.querySelector('img, script')).toBeNull();
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText('bad')).not.toHaveAttribute('href');
    expect(screen.getByText('ok')).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByText('Name').getAttribute('style')).toBe('color: rgb(255, 0, 0);');
  });

  it('renders the XSS corpus as inert text and safe elements', () => {
    const types = ['paragraph', 'heading', 'short_text'] as const;
    renderPreview(
      XSS_PAYLOADS.map((html, i) => {
        const type = types[i % types.length] as (typeof types)[number];
        if (type === 'paragraph') return block('paragraph', `b${i}`, { config: { content: fromHtml(html).doc } });
        if (type === 'heading') return block('heading', `b${i}`, { config: { level: 2, text: fromHtmlInline(html).doc } });
        return block('short_text', `b${i}`, { label: fromHtmlInline(html).doc });
      }),
    );
    const elements = [...document.body.querySelectorAll('*')];
    expect(elements.flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => name.startsWith('on'))).toEqual([]);
    for (const a of document.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^(https?:\/\/|mailto:|tel:)/);
    const form = document.querySelector('form');
    expect(form?.textContent).toContain('docs');
    expect(form?.querySelector('script, img, iframe, svg, math, dialog, object, embed, style, form, base, meta, link, template')).toBeNull();
  }, 30_000);

  it('B28: rating and scale point counts stay in range', () => {
    renderPreview([block('rating', 'r', { label: 'Stars', config: { max: 10 } }), block('linear_scale', 's', { label: 'Scale', config: { min: 1, max: 10 } })]);
    expect(within(screen.getByRole('radiogroup', { name: 'Stars' })).getAllByRole('radio')).toHaveLength(10);
    const scale = within(screen.getByRole('radiogroup', { name: 'Scale' }));
    expect(scale.getByRole('radio', { name: '10' })).toBeInTheDocument();
    expect(scale.queryByRole('radio', { name: '11' })).not.toBeInTheDocument();
  });

  it('B7: an unanswered NPS shows no score selected', () => {
    renderPreview([block('nps', 'nps', { label: 'Recommend?' })]);
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([]);
    expect(screen.getByRole('radio', { name: '0' })).toHaveAttribute('aria-checked', 'false');
  });

  it('B7: an unanswered linear scale starting at 0 shows nothing selected', () => {
    renderPreview([block('linear_scale', 'scale', { label: 'Scale', config: { min: 0, max: 5 } })]);
    expect(screen.getByRole('radio', { name: '0' })).toHaveAttribute('aria-checked', 'false');
  });
});
