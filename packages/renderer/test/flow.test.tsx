// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BlockId, EndingId, FileId, FileRef, OptionId, PlainTemplate, RuntimeStatus, SafeUrl, Sha256Hex, SubmitResult } from '@form/schema';
import { FormRenderer, type RendererEvent, type SubmitHandler, type SubmitPayload, type Uploader } from '../src/index.ts';
import { field, form, id, options, page, props, rich, rule, runtime, show, when } from './build.ts';

/*
 * A respondent's way through a form: paging with Next and Back, logic showing and hiding fields, page-scoped
 * validation, the submit payload, server results, status screens and endings.
 */

const REQUIRED = 'This field is required.';

/** Three pages; page 2 has a required "reason" shown only when page 1 answers yes. */
function threePages() {
  const yesNo = field('single_choice', 'attending', {
    required: true,
    config: { display: 'radio', options: [{ id: id<OptionId>('yes'), label: 'Yes' }, { id: id<OptionId>('no'), label: 'No' }] },
  });
  const reason = field('short_text', 'reason', { required: true, initiallyHidden: true });
  const city = field('short_text', 'city', { required: true });
  const email = field('email', 'email', { required: true });
  return form(
    [field('short_text', 'name', { required: true }), yesNo, reason, city, email],
    [page('p1', ['name', 'attending']), page('p2', ['reason', 'city']), page('p3', ['email'])],
    [rule('r1', when('attending', 'eq', options('attending', 'yes')), [show('reason')])],
  );
}

describe('paging, logic and submit', () => {
  it('3 pages: logic hides a required field, submit works, and the hidden answer is absent from onSubmit', async () => {
    const submitted: SubmitPayload[] = [];
    const events: RendererEvent[] = [];
    const saves: unknown[] = [];
    render(
      <FormRenderer
        {...props(runtime(threePages()), {
          onSubmit: (p) => void submitted.push(p),
          onEvent: (e) => void events.push(e),
          onPartialSave: (d) => void saves.push(d),
        })}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByRole('textbox', { name: /reason/ }), 'Keynote');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('textbox', { name: /city/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /reason/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /city/ }), 'Pune');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByRole('textbox', { name: /email/ }), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    const answers = submitted[0]?.answers ?? {};
    expect(Object.keys(answers).sort()).toEqual(['attending', 'city', 'email', 'name']);
    expect(answers['reason' as BlockId]).toBeUndefined();
    expect(submitted[0]?.pageTrail).toEqual(['p1', 'p2', 'p3']);
    expect(await screen.findByRole('heading', { name: 'Thanks for your response!' })).toBeInTheDocument();
    expect(events.map((e) => e.type)).toEqual(['page', 'page', 'page', 'page', 'submitted']);
    expect(saves).toHaveLength(3);
  });

  it('B1: Next validates only the current page; B2: a hidden required field never blocks', async () => {
    render(<FormRenderer {...props(runtime(threePages()))} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findAllByText(REQUIRED)).toHaveLength(2);
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('radio', { name: 'No' }));
    await waitFor(() => expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('textbox', { name: /city/ })).toBeInTheDocument();
  });

  it('marks invalid fields, describes them by their error, announces the count and focuses the first', async () => {
    render(<FormRenderer {...props(runtime(threePages()))} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const name = await screen.findByRole('textbox', { name: /name/ });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(REQUIRED);
    expect(screen.getByRole('radiogroup', { name: /attending/ })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('2 answers need attention.');
    await waitFor(() => expect(name).toHaveFocus());
  });

  it('labels required fields for assistive technology', () => {
    render(<FormRenderer {...props(runtime(threePages()))} />);
    const name = screen.getByRole('textbox', { name: /name/ });
    expect(name).toHaveAccessibleName('name (required)');
    expect(name).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('radiogroup', { name: /attending/ })).toHaveAttribute('aria-required', 'true');
  });

  it('shows server field errors from an invalid result and does not show the ending', async () => {
    const result: SubmitResult = { ok: false, kind: 'invalid', status: 422, errors: [{ blockId: 'name' as BlockId, code: 'not_unique', message: 'Already registered.' }] };
    const def = form([field('short_text', 'name', { required: true })], [page('p1', ['name'])]);
    render(<FormRenderer {...props(runtime(def), { onSubmit: () => Promise.resolve(result) })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Already registered.')).toBeInTheDocument();
    expect(screen.queryByText('Thanks for your response!')).not.toBeInTheDocument();
  });

  it('a server error on an earlier page takes the respondent back to it and focuses the field', async () => {
    const result: SubmitResult = { ok: false, kind: 'invalid', status: 422, errors: [{ blockId: 'email' as BlockId, code: 'not_unique', message: 'Already registered.' }] };
    const def = form(
      [field('email', 'email', { required: true }), field('short_text', 'city'), field('short_text', 'note')],
      [page('p1', ['email']), page('p2', ['city']), page('p3', ['note'])],
    );
    const events: RendererEvent[] = [];
    render(<FormRenderer {...props(runtime(def), { onSubmit: () => Promise.resolve(result), onEvent: (e) => void events.push(e) })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /email/ }), 'asha@example.in');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Submit' }));

    const email = await screen.findByRole('textbox', { name: /email/ });
    expect(email).toHaveValue('asha@example.in');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Already registered.');
    await waitFor(() => expect(email).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(events.at(-1)).toEqual({ type: 'page', pageId: 'p1', index: 0 });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('textbox', { name: /city/ })).toBeInTheDocument();
  });

  it('shows a server error for a block on no page of the path with the form errors', async () => {
    const result: SubmitResult = { ok: false, kind: 'invalid', status: 422, errors: [{ blockId: 'gone' as BlockId, code: 'invalid_format', message: 'That answer was not accepted.' }] };
    const def = form([field('short_text', 'name')], [page('p1', ['name'])]);
    render(<FormRenderer {...props(runtime(def), { onSubmit: () => Promise.resolve(result) })} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That answer was not accepted.');
  });

  it('loads re2js for a form with a preset and validates with it', async () => {
    const submitted: SubmitPayload[] = [];
    const def = form([field('short_text', 'pin', { config: { preset: 'in_pincode' } })], [page('p1', ['pin'])]);
    render(<FormRenderer {...props(runtime(def), { onSubmit: (p) => void submitted.push(p) })} />);
    const user = userEvent.setup();
    const pin = screen.getByRole('textbox', { name: /pin/ });
    await user.type(pin, '12');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(pin).toHaveAttribute('aria-invalid', 'true'));
    expect(submitted).toEqual([]);
    await user.clear(pin);
    await user.type(pin, '560001');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
  });

  it('the theme prop overrides the progress style', () => {
    const def = form([field('short_text', 'a'), field('short_text', 'b')], [page('p1', ['a']), page('p2', ['b'])]);
    const version = runtime(def);
    const theme = { ...def.theme, tokens: { ...def.theme.tokens, progress: 'percent' as const } };
    render(<FormRenderer {...props(version, { theme })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('50% complete')).toBeInTheDocument();
  });

  it('keeps the answers and says so when submitting fails', async () => {
    const def = form([field('short_text', 'name')], [page('p1', ['name'])]);
    render(<FormRenderer {...props(runtime(def), { onSubmit: () => Promise.reject(new Error('offline')) })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your response could not be sent. Try again.');
    expect(screen.getByRole('textbox', { name: /name/ })).toHaveValue('Asha');
  });

  it('sends once when Submit is clicked again while an upload is still running', async () => {
    const def = form([field('file_upload', 'cv', { required: true })], [page('p1', ['cv'])]);
    let finishUpload: (ref: FileRef) => void = () => undefined;
    const uploader: Uploader = () => new Promise<FileRef>((resolve) => { finishUpload = resolve; });
    const submitted: SubmitPayload[] = [];
    render(<FormRenderer {...props(runtime(def), { uploader, onSubmit: (p) => void submitted.push(p) })} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/cv/), new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    await user.click(submit);
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await user.click(submit);
    await user.click(submit);
    finishUpload({ fileId: id<FileId>('file_1'), name: 'cv.pdf', sizeBytes: 4, mime: 'application/pdf', sha256: id<Sha256Hex>('0'.repeat(64)) });
    await waitFor(() => expect(submitted).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitted).toHaveLength(1);
  });

  it('shows the ending the server chose, and Submit another response starts again', async () => {
    const def = form([field('short_text', 'name')], [page('p1', ['name'])], [], {
      endings: [
        { id: id<EndingId>('ending_1'), kind: 'message', name: 'Thanks', content: rich('Thanks!'), actions: [] },
        { id: id<EndingId>('waitlist'), kind: 'message', name: 'Waitlist', content: rich('You are on the waitlist.'), actions: [{ kind: 'fill_again', prefill: 'none' }] },
      ],
    });
    const events: RendererEvent[] = [];
    render(<FormRenderer {...props(runtime(def), { onSubmit: () => ({ ok: true, submissionId: id('s1'), endingId: id<EndingId>('waitlist') }), onEvent: (e) => void events.push(e) })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('heading', { name: 'You are on the waitlist.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    expect(await screen.findByRole('textbox', { name: /name/ })).toHaveValue('');
    expect(events.map((e) => e.type)).toEqual(['submitted', 'restart']);
  });

  it('a redirect ending reports the https URL with piped answers, and preview never navigates', async () => {
    const url: PlainTemplate = ['https://example.com/next?name=', { pipe: { source: { kind: 'answer', blockId: id('name') }, encode: 'url' } }];
    const def = form([field('short_text', 'name')], [page('p1', ['name'])], [], {
      endings: [{ id: id<EndingId>('ending_1'), kind: 'redirect', name: 'Go', url, message: rich('Redirecting…') }],
    });
    const events: RendererEvent[] = [];
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(<FormRenderer {...props(runtime(def), { mode: 'preview', onEvent: (e) => void events.push(e) })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'A & B');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(events.find((e) => e.type === 'redirect')).toEqual({ type: 'redirect', url: 'https://example.com/next?name=A%20%26%20B' as SafeUrl, delayMs: 0 }));
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('percent-encodes every piped value in a redirect URL, whatever the pipe says', async () => {
    const url: PlainTemplate = ['https://example.com/next?name=', { pipe: { source: { kind: 'answer', blockId: id('name') } } }];
    const def = form([field('short_text', 'name')], [page('p1', ['name'])], [], {
      endings: [{ id: id<EndingId>('ending_1'), kind: 'redirect', name: 'Go', url, message: rich('Redirecting…') }],
    });
    const events: RendererEvent[] = [];
    render(<FormRenderer {...props(runtime(def), { mode: 'preview', onEvent: (e) => void events.push(e) })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /name/ }), 'x&admin=1#top');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(events.find((e) => e.type === 'redirect')).toEqual({ type: 'redirect', url: 'https://example.com/next?name=x%26admin%3D1%23top', delayMs: 0 }));
  });

  it('in live mode reports only an https URL the server returned, with the delay, and never navigates itself', async () => {
    const url: PlainTemplate = ['https://example.com/next'];
    const def = form([field('short_text', 'name')], [page('p1', ['name'])], [], {
      endings: [{ id: id<EndingId>('ending_1'), kind: 'redirect', name: 'Go', url, delayMs: 1500, message: rich('Redirecting…') }],
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const events: RendererEvent[] = [];
    const view = render(<FormRenderer {...props(runtime(def), { onEvent: (e) => void events.push(e) })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(events.map((e) => e.type)).toEqual(['submitted']));
    view.unmount();

    const accepted = (redirectUrl: string): SubmitHandler => () => ({ ok: true, submissionId: id('s1'), endingId: id<EndingId>('ending_1'), redirectUrl: redirectUrl as SafeUrl });
    for (const unsafe of ['javascript:alert(1)', 'http://example.com/next']) {
      events.length = 0;
      const rejected = render(<FormRenderer {...props(runtime(def), { onSubmit: accepted(unsafe), onEvent: (e) => void events.push(e) })} />);
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(events.map((e) => e.type)).toEqual(['submitted']));
      rejected.unmount();
    }

    const server = 'https://example.com/next?ref=s1' as SafeUrl;
    render(<FormRenderer {...props(runtime(def), { onSubmit: accepted(server), onEvent: (e) => void events.push(e) })} />);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(events.at(-1)).toEqual({ type: 'redirect', url: server, delayMs: 1500 }));
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows a closed status with the author screen', () => {
    const status: RuntimeStatus = { state: 'closed', screen: rich('We are closed for the season.') };
    render(<FormRenderer {...props(runtime(threePages(), status))} />);
    expect(screen.getByRole('heading', { name: 'We are closed for the season.' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('asks for a password and hands it to onUnlock, never to onEvent; the host opens the form', async () => {
    const events: RendererEvent[] = [];
    const attempts: string[] = [];
    const version = runtime(threePages(), { state: 'password', screen: { type: 'doc', content: [] } });
    const view = render(<FormRenderer {...props(version, { onEvent: (e) => void events.push(e), onUnlock: (p) => void attempts.push(p) })} />);
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { name: 'Enter the password to open this form.' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'open sesame');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(attempts).toEqual(['open sesame']);
    expect(events).toEqual([{ type: 'unlock' }]);
    view.rerender(<FormRenderer {...props(version, { status: { state: 'open' } })} />);
    expect(screen.getByRole('textbox', { name: /name/ })).toBeInTheDocument();
  });

  it('shows a welcome screen first when the form has one', async () => {
    const def = { ...threePages(), welcome: { enabled: true, content: rich('Welcome to the survey.'), startLabel: 'Begin' } };
    render(<FormRenderer {...props(runtime(def))} />);
    const user = userEvent.setup();
    expect(screen.getByText('Welcome to the survey.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Begin' }));
    expect(screen.getByRole('textbox', { name: /name/ })).toBeInTheDocument();
  });

  it('starts from initial answers and field defaults, and pipes answers into labels', async () => {
    const def = form(
      [
        field('short_text', 'name', { config: { defaultValue: { kind: 'static', value: 'Asha' } } }),
        field('date', 'day', { config: { defaultValue: { kind: 'today' } } }),
        field('short_text', 'greeting', {
          label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'pipe', attrs: { source: { kind: 'answer', blockId: id('name') }, fallback: 'there' } }] }] },
        }),
      ],
      [page('p1', ['name', 'day', 'greeting'])],
    );
    render(<FormRenderer {...props(runtime(def), { initialAnswers: { greeting: { type: 'short_text', value: 'Hi' } } as never })} />);
    expect(screen.getByRole('textbox', { name: 'name' })).toHaveValue('Asha');
    expect(screen.getByLabelText('day')).toHaveValue('2026-10-19');
    expect(screen.getByRole('textbox', { name: 'Hello Asha' })).toHaveValue('Hi');
    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox', { name: 'name' }));
    expect(await screen.findByRole('textbox', { name: 'Hello there' })).toBeInTheDocument();
  });
});
