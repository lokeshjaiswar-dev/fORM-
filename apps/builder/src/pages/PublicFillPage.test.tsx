import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { RuntimeFormVersionSchema, type FormVersionId, type IsoInstant, type RuntimeFormVersion, type RuntimeStatus, type StoredBlock } from '@form/schema';
import { richDoc } from '@/lib/definition';
import { previewVersion } from '@/lib/preview';
import { PublicFillPage } from '@/pages/PublicFillPage';
import { block, formWith } from '@/test/fixtures';

const NOW = '2026-11-15T04:30:00.000Z' as IsoInstant;
const FORM_ID = '0198a2c0-0000-7000-8000-000000000001';
const V1 = '0198a2c0-0000-7000-8000-0000000000a1';
const V2 = '0198a2c0-0000-7000-8000-0000000000a2';

/** A runtime version as `GET /v1/p/:slug` sends it: compiled and projected, with a uuid for its id, and checked by the contract's own schema. */
function versionOf(blocks: StoredBlock[], id: string, status: RuntimeStatus = { state: 'open' }): RuntimeFormVersion {
  const built = previewVersion({ ...formWith(blocks), formId: FORM_ID as never }, status, NOW);
  if (!built.ok) throw new Error('the fixture form does not compile');
  return RuntimeFormVersionSchema.parse({ ...built.version, versionId: id as FormVersionId, formId: FORM_ID }) as RuntimeFormVersion;
}

const nameField = () => block('short_text', 'name', { label: 'Name', key: 'name', required: true });
const closed: RuntimeStatus = { state: 'closed', screen: richDoc('Registrations closed on Friday.') };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, instance: '/', requestId: 'r1', ...extra });

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: any;
}

/** A fake API: `routes` answer by "METHOD path" (a function sees the call, and is asked once per call). */
function fakeApi(routes: Record<string, Response | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const call: Call = {
        method,
        path: String(url),
        headers: (init.headers ?? {}) as Record<string, string>,
        credentials: init.credentials,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const answer = routes[`${method} ${call.path}`];
      if (answer === undefined) return Promise.resolve(problem(404, 'NOT_FOUND'));
      return Promise.resolve(typeof answer === 'function' ? answer(call) : answer.clone());
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

function Where() {
  return <span aria-label="path">{useLocation().pathname}</span>;
}

function renderPage(path = '/f/feedback') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/f/:slug" element={<PublicFillPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const open = (version: RuntimeFormVersion, slug = 'feedback') => json(200, { slug, formId: FORM_ID, status: version.status, version });

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('PublicFillPage: status', () => {
  it('shows the closed screen of a closed form, and never the form', async () => {
    fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1, closed)) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Registrations closed on Friday.' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Name/ })).not.toBeInTheDocument();
  });

  it('shows the screen of every other status the API gives: not yet open, outside hours, full', async () => {
    const cases: Array<[RuntimeStatus, string]> = [
      [{ state: 'not_yet_open', opensAt: '2026-12-01T03:30:00.000Z' as IsoInstant, screen: richDoc('Opens on 1 December.') }, 'Opens on 1 December.'],
      [{ state: 'outside_hours', screen: richDoc('Back at nine.') }, 'Back at nine.'],
      [{ state: 'limit_reached', screen: richDoc('All places are taken.') }, 'All places are taken.'],
    ];
    for (const [status, text] of cases) {
      fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1, status)) });
      const { unmount } = renderPage();
      expect(await screen.findByRole('heading', { name: text })).toBeInTheDocument();
      unmount();
    }
  });

  it('a status screen with no author text of its own says it in the renderer’s words', async () => {
    fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1, { state: 'limit_reached', screen: { type: 'doc', content: [] } })) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This form is no longer accepting responses.' })).toBeInTheDocument();
  });

  it('a form that is not published is "Form not found"', async () => {
    fakeApi({});
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Form not found' })).toBeInTheDocument();
  });

  it('every call is anonymous: no session cookie, even from a browser signed in to the builder', async () => {
    const api = fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)) });
    renderPage();
    await screen.findByRole('textbox', { name: /Name/ });
    expect(api.calls.every((c) => c.credentials === 'omit')).toBe(true);
  });
});

describe('PublicFillPage: password', () => {
  const locked = json(200, { slug: 'feedback', formId: FORM_ID, status: { state: 'password', screen: { type: 'doc', content: [] } } });

  it('asks for the password, unlocks on the server, keeps the token in memory and sends it as X-FR-Access, then shows the form', async () => {
    const version = versionOf([nameField()], V1);
    const api = fakeApi({
      'GET /v1/p/feedback': (call) => (call.headers['x-fr-access'] === 'token-1' ? open(version) : locked.clone()),
      'POST /v1/p/feedback/unlock': json(200, { accessToken: 'token-1', expiresAt: '2026-11-15T06:30:00.000Z' }),
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    // The form's questions were withheld by the server: there is nothing to show before the password.
    expect(screen.queryByRole('textbox', { name: /Name/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'violet-anchor-teapot-91');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('textbox', { name: /Name/ })).toBeInTheDocument();
    expect(api.called('POST', '/v1/p/feedback/unlock')[0]?.body).toEqual({ password: 'violet-anchor-teapot-91' });
    expect(api.called('GET', '/v1/p/feedback').map((c) => c.headers['x-fr-access'])).toEqual([undefined, 'token-1']);
    // Memory only: nothing about the password or the token is stored in this browser.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('token-1');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('token-1');
  });

  it('a wrong password is said next to the prompt and the form stays locked; a rate limit says to wait', async () => {
    fakeApi({ 'GET /v1/p/feedback': locked, 'POST /v1/p/feedback/unlock': problem(401, 'FORM_UNLOCK_FAILED') });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not right');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    fakeApi({ 'GET /v1/p/feedback': locked, 'POST /v1/p/feedback/unlock': problem(429, 'RATE_LIMITED') });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });

  it('a closed form behind a password shows the closed screen, not the prompt', async () => {
    fakeApi({ 'GET /v1/p/feedback': json(200, { slug: 'feedback', formId: FORM_ID, status: closed }) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Registrations closed on Friday.' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('PublicFillPage: old addresses', () => {
  it('follows {redirectTo} to the form’s current address', async () => {
    const api = fakeApi({
      'GET /v1/p/old-name': json(200, { redirectTo: 'new-name' }),
      'GET /v1/p/new-name': open(versionOf([nameField()], V1), 'new-name'),
    });
    renderPage('/f/old-name');
    expect(await screen.findByRole('textbox', { name: /Name/ })).toBeInTheDocument();
    expect(screen.getByLabelText('path')).toHaveTextContent('/f/new-name');
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/p/old-name', '/v1/p/new-name']);
  });

  it('a redirect that points at itself does not loop', async () => {
    const api = fakeApi({ 'GET /v1/p/loop': json(200, { redirectTo: 'loop' }) });
    renderPage('/f/loop');
    expect(await screen.findByRole('heading', { name: 'This form cannot be opened' }, { timeout: 8000 })).toBeInTheDocument();
    expect(api.calls.length).toBeLessThan(6);
  });
});

describe('PublicFillPage: submit', () => {
  /** Opens the page, types a name and presses Submit. */
  async function fill(user: ReturnType<typeof userEvent.setup>, name = 'Asha') {
    const input = await screen.findByRole('textbox', { name: /Name/ });
    await user.clear(input);
    await user.type(input, name);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
  }

  const taken = json(200, { ok: true, submissionId: '0198a2c0-0000-7000-8000-0000000000b1', endingId: 'ending' });

  it('sends an Idempotency-Key and the client meta; the address has no query and the referrer is its site only', async () => {
    window.history.replaceState(null, '', '/f/feedback?utm_source=mail&token=secret');
    Object.defineProperty(document, 'referrer', { value: 'https://news.example/a/story?id=7', configurable: true });
    try {
      const api = fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)), 'POST /v1/p/feedback/submissions': taken });
      const user = userEvent.setup();
      renderPage();
      await fill(user);
      expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
      const [post] = api.called('POST', '/v1/p/feedback/submissions');
      expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(post?.body).toMatchObject({ formVersionId: V1, locale: 'en-IN', answers: { name: { type: 'short_text', value: 'Asha' } } });
      expect(post?.body.client).toMatchObject({
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        timeZone: expect.any(String),
        pageUrl: `${window.location.origin}/f/feedback`,
        referrer: 'https://news.example',
        device: expect.stringMatching(/^(desktop|tablet|mobile)$/),
        urlParams: { utm_source: 'mail', token: 'secret' },
      });
      expect(post?.body.client.pageUrl).not.toContain('?');
    } finally {
      Object.defineProperty(document, 'referrer', { value: '', configurable: true });
      window.history.replaceState(null, '', '/');
    }
  });

  it('reuses the same Idempotency-Key on a retried submit, and a different one for other answers', async () => {
    let tries = 0;
    const api = fakeApi({
      'GET /v1/p/feedback': open(versionOf([nameField()], V1)),
      // The first answer is lost to a server error; the retry is accepted.
      'POST /v1/p/feedback/submissions': () => (++tries === 1 ? problem(503, 'SERVICE_UNAVAILABLE') : taken.clone()),
    });
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    expect(await screen.findByText(/Something went wrong|could not be sent|try again/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
    const posts = api.called('POST', '/v1/p/feedback/submissions');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers['idempotency-key']).toBe(posts[0]?.headers['idempotency-key']);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
  });

  it('other answers after a refused try are another submission with another key', async () => {
    let tries = 0;
    const api = fakeApi({
      'GET /v1/p/feedback': open(versionOf([nameField()], V1)),
      'POST /v1/p/feedback/submissions': () => (++tries === 1 ? problem(503, 'SERVICE_UNAVAILABLE') : taken.clone()),
    });
    const user = userEvent.setup();
    renderPage();
    await fill(user, 'Asha');
    await screen.findByText(/Something went wrong|could not be sent|try again/i);
    await user.clear(screen.getByRole('textbox', { name: /Name/ }));
    await user.type(screen.getByRole('textbox', { name: /Name/ }), 'Asha K');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
    const keys = api.called('POST', '/v1/p/feedback/submissions').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('maps a 422 to errors next to the fields the server named, and keeps what was typed', async () => {
    fakeApi({
      'GET /v1/p/feedback': open(versionOf([nameField()], V1)),
      'POST /v1/p/feedback/submissions': problem(422, 'SUBMISSION_INVALID', { errors: [{ path: 'name', message: 'That name is already registered.' }] }),
    });
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    expect(await screen.findByText('That name is already registered.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name/ })).toHaveValue('Asha');
    expect(screen.queryByText('Thanks for your response!')).not.toBeInTheDocument();
  });

  it('a 422 about something that is not a field of the form is shown in the summary, not lost', async () => {
    fakeApi({
      'GET /v1/p/feedback': open(versionOf([nameField()], V1)),
      'POST /v1/p/feedback/submissions': problem(422, 'SUBMISSION_INVALID', { errors: [{ path: 'locale', message: 'not a language of this form' }] }),
    });
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    expect(await screen.findByText(/not a language of this form/)).toBeInTheDocument();
  });

  it('VERSION_SUPERSEDED offers a reload; it loads the new version and carries the answers over by field key', async () => {
    // The new version rebuilt the Name field under another block id (same key) and added a question.
    const renamed = block('short_text', 'full_name', { label: 'Name', key: 'name', required: true });
    const added = block('short_text', 'city', { label: 'City', key: 'city' });
    let reads = 0;
    const api = fakeApi({
      'GET /v1/p/feedback': () => open(reads++ === 0 ? versionOf([nameField()], V1) : versionOf([renamed, added], V2)).clone(),
      'POST /v1/p/feedback/submissions': problem(409, 'VERSION_SUPERSEDED'),
    });
    const user = userEvent.setup();
    renderPage();
    await fill(user, 'Asha');

    const offer = (await screen.findByText('This form was updated while you were filling it.')).closest('[role="alert"]') as HTMLElement;
    expect(within(offer).getByText(/Your answers to the questions that are still there are kept/)).toBeInTheDocument();
    await user.click(within(offer).getByRole('button', { name: 'Reload with my answers' }));

    expect(await screen.findByRole('textbox', { name: /City/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name/ })).toHaveValue('Asha');
    expect(screen.queryByRole('button', { name: 'Reload with my answers' })).not.toBeInTheDocument();
    expect(api.called('GET', '/v1/p/feedback')).toHaveLength(2);

    // The next submission is for the new version.
    const next = fakeApi({ 'POST /v1/p/feedback/submissions': taken });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(next.called('POST', '/v1/p/feedback/submissions')).toHaveLength(1));
    const body = next.called('POST', '/v1/p/feedback/submissions')[0]?.body as { formVersionId: string; answers: Record<string, unknown> };
    expect(body.formVersionId).toBe(V2);
    expect(body.answers).toMatchObject({ full_name: { type: 'short_text', value: 'Asha' } });
  });

  it('FORM_CLOSED and LIMIT_REACHED are told to the respondent, and nothing is submitted', async () => {
    for (const [code, text] of [
      ['FORM_CLOSED', /closed/i],
      ['LIMIT_REACHED', /no longer accepting responses/],
    ] as const) {
      fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)), 'POST /v1/p/feedback/submissions': problem(409, code) });
      const user = userEvent.setup();
      const { unmount } = renderPage();
      await fill(user);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByText('Thanks for your response!')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('PASSWORD_REQUIRED (the token ended) goes back to the password prompt', async () => {
    const version = versionOf([nameField()], V1);
    let withToken = true;
    fakeApi({
      'GET /v1/p/feedback': (call) => (call.headers['x-fr-access'] && withToken ? open(version) : json(200, { slug: 'feedback', formId: FORM_ID, status: { state: 'password', screen: { type: 'doc', content: [] } } })),
      'POST /v1/p/feedback/unlock': json(200, { accessToken: 'token-1', expiresAt: '2026-11-15T06:30:00.000Z' }),
      'POST /v1/p/feedback/submissions': () => {
        withToken = false;
        return problem(401, 'PASSWORD_REQUIRED');
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Password'), 'violet-anchor-teapot-91');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await fill(user);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });
});

describe('PublicFillPage: a submission held for review', () => {
  const answered = { ok: true, submissionId: '0198a2c0-0000-7000-8000-0000000000b1', endingId: 'ending' };
  const held = json(200, { ...answered, held: 'pending_review' });

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByRole('textbox', { name: /Name/ }), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
  }

  it('says the submission is under review when the API answers held: pending_review, beside the form’s own ending', async () => {
    fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)), 'POST /v1/p/feedback/submissions': held });
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByText('Your submission is under review')).not.toBeInTheDocument();
    await fill(user);
    // The ending the author wrote still shows; the notice says it is not final yet.
    expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
    // A polite live region, so a screen reader says it (the renderer has a status region of its own, so the notice is found by its words).
    const notice = screen.getByText('Your submission is under review').closest('[role="status"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(within(notice).getByText(/reviewer has to check it before it is final/)).toBeInTheDocument();
  });

  it('says nothing about review for a submission that is final, or whose held status it does not know', async () => {
    for (const reply of [json(200, answered), json(200, { ...answered, held: 'pending_scan' })]) {
      fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)), 'POST /v1/p/feedback/submissions': reply });
      const user = userEvent.setup();
      const { unmount } = renderPage();
      await fill(user);
      expect(await screen.findByText('Thanks for your response!')).toBeInTheDocument();
      expect(screen.queryByText('Your submission is under review')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('takes the notice away when the respondent starts another response', async () => {
    fakeApi({ 'GET /v1/p/feedback': open(versionOf([nameField()], V1)), 'POST /v1/p/feedback/submissions': held });
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    expect(await screen.findByText('Your submission is under review')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    expect(await screen.findByRole('textbox', { name: /Name/ })).toBeInTheDocument();
    expect(screen.queryByText('Your submission is under review')).not.toBeInTheDocument();
  });
});
