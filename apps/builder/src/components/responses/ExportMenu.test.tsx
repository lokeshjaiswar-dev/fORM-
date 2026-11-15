import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore, type Me } from '@/auth/client';
import { ExportMenu } from '@/components/responses/ExportMenu';
import { dayEnd, dayStart } from '@/components/responses/filters';
import type { ExportState } from '@/persistence/exportsApi';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'editor' }],
  activeOrgId: 'o1',
};

const FORM = 'f1';
const ID = '0196f0a0-0000-7000-8000-0000000000e1';
const GRANTS = ['forms.read', 'submissions.read', 'submissions.export'];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string) => json(status, { type: 'about:blank', title: code, status, code });

const exportState = (status: ExportState['status'], more: Partial<ExportState> = {}): ExportState => ({
  id: ID,
  formId: FORM,
  format: 'csv',
  scope: { kind: 'all' },
  includeSensitive: false,
  status,
  rowCount: status === 'ready' ? 3 : null,
  bytes: status === 'ready' ? 12 : null,
  error: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  finishedAt: null,
  expiresAt: null,
  ...more,
});

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface Api {
  calls: Call[];
  posts: () => Call[];
  saved: Array<{ name: string; text: string }>;
}

/**
 * The API behind the menu: the org (what the role grants), then the export routes. `post` answers each request for an
 * export (a function of the call number, so a test can fail the first ones), and every other call answers as the API would.
 */
function fakeApi(o: { permissions?: string[]; post?: (n: number) => Response | Error; poll?: () => Response } = {}): Api {
  const calls: Call[] = [];
  const saved: Api['saved'] = [];
  let posted = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url === '/v1/org') return Promise.resolve(json(200, { org: { id: 'o1' }, role: 'editor', permissions: o.permissions ?? GRANTS }));
      if (url === `/v1/forms/${FORM}/exports` && method === 'POST') {
        posted += 1;
        const answer = o.post ? o.post(posted) : json(200, exportState('ready'));
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }
      if (url === `/v1/exports/${ID}` && method === 'GET') return Promise.resolve(o.poll ? o.poll() : json(200, exportState('ready')));
      if (url === `/v1/exports/${ID}/download`) {
        return Promise.resolve(new Response('name\nAsha\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="Feedback-2026-11-16.csv"' } }));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  // The browser's save: jsdom has no blob URLs and no downloads, so the link is read when it is clicked.
  Object.assign(URL, { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: '' });
  });
  return { calls, saved, posts: () => calls.filter((c) => c.method === 'POST') };
}

function renderMenu(props: Partial<React.ComponentProps<typeof ExportMenu>> = {}) {
  return render(<ExportMenu formId={FORM} selectedIds={[]} from="" to="" {...props} />);
}

const exportButton = () => screen.queryByRole('button', { name: 'Export' });
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Export' }));
  return screen.findByRole('dialog', { name: 'Export responses' });
};
const start = () => screen.getByRole('button', { name: 'Start export' });

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ExportMenu', () => {
  it('is hidden when the org does not grant submissions.export, once the grants are known', async () => {
    const api = fakeApi({ permissions: ['forms.read', 'submissions.read'] });
    renderMenu();
    await waitFor(() => expect(api.calls.map((c) => c.path)).toEqual(['/v1/org']));
    // The answer has been read: still nothing to press.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exportButton()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is hidden when the grants cannot be read, and when nobody is signed in (no call is made)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(problem(500, 'INTERNAL'))));
    const { unmount } = renderMenu();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exportButton()).toBeNull();
    unmount();

    useSessionStore.setState({ status: 'signed_out' }, true);
    const api = fakeApi();
    renderMenu();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exportButton()).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('shows the Export button to a member whose role grants submissions.export', async () => {
    fakeApi();
    renderMenu();
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('exports all responses as CSV: posts {format, scope} with an Idempotency-Key, then saves the file the API names', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    expect(screen.getByRole('radio', { name: /CSV/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'All responses' })).toBeChecked();
    await user.click(start());

    expect(await screen.findByText('Downloaded Feedback-2026-11-16.csv.')).toBeInTheDocument();
    const [post] = api.posts();
    expect(api.posts()).toHaveLength(1);
    expect(post!.body).toEqual({ format: 'csv', scope: { kind: 'all' } });
    expect(post!.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(post!.headers['x-fr-org']).toBe('o1');
    expect(api.saved).toEqual([{ name: 'Feedback-2026-11-16.csv', text: '' }]);
  });

  it('waits for a queued export, tells the member what it is doing, and saves the file once it is ready', async () => {
    let polls = 0;
    const api = fakeApi({ post: () => json(200, exportState('queued')), poll: () => (polls++ === 0 ? json(200, exportState('running')) : json(200, exportState('ready'))) });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    expect(await screen.findByText('Waiting for the export to start…')).toBeInTheDocument();
    expect(await screen.findByText('Building your file…', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText('Downloaded Feedback-2026-11-16.csv.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === `/v1/exports/${ID}`)).toHaveLength(2);
    expect(api.posts()).toHaveLength(1);
  });

  it('exports the selected rows, or a date range, and Excel when asked', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    const { unmount } = renderMenu({ selectedIds: ['r1', 'r2'] });
    await open(user);
    // With rows ticked the selection is what is offered first.
    expect(screen.getByRole('radio', { name: '2 selected responses' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Excel/ }));
    await user.click(start());
    await screen.findByText(/^Downloaded /);
    expect(api.posts()[0]!.body).toEqual({ format: 'xlsx', scope: { kind: 'selected', ids: ['r1', 'r2'] } });
    unmount();

    renderMenu({ from: '2026-11-01', to: '' });
    await open(user);
    // Dates set in the filters above the grid are where the range starts.
    expect(screen.getByRole('radio', { name: 'Received between' })).toBeChecked();
    expect(screen.getByLabelText('From')).toHaveValue('2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-15');
    await user.click(start());
    await waitFor(() => expect(api.posts()).toHaveLength(2));
    expect(api.posts()[1]!.body).toEqual({ format: 'csv', scope: { kind: 'filtered', from: dayStart('2026-11-01'), to: dayEnd('2026-11-15') } });
  });

  it('offers no selection when nothing is ticked, and a range needs a date that is not backwards', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    expect(screen.getByRole('radio', { name: /none selected/ })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Received between' }));
    expect(start()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a start date, an end date, or both.');
    await user.type(screen.getByLabelText('From'), '2026-11-10');
    expect(start()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.posts()).toHaveLength(0);
  });

  it('keeps Start off while "include sensitive" has no reason, then sends the reason with the request', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    expect(start()).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Include sensitive and encrypted fields' }));
    expect(start()).toBeDisabled();
    await user.type(screen.getByLabelText('Why do you need them?'), '   ');
    expect(start()).toBeDisabled();
    await user.type(screen.getByLabelText('Why do you need them?'), 'DSR #12, copy for the principal');
    expect(start()).toBeEnabled();
    await user.click(start());
    await screen.findByText(/^Downloaded /);
    expect(api.posts()[0]!.body).toEqual({ format: 'csv', scope: { kind: 'all' }, includeSensitive: true, reason: 'DSR #12, copy for the principal' });
    // Taking the option off again sends a plain request.
    await user.click(screen.getByRole('checkbox', { name: 'Include sensitive and encrypted fields' }));
    expect(screen.queryByLabelText('Why do you need them?')).toBeNull();
    expect(start()).toBeEnabled();
  });

  it('says "try later" for a 429, then a new Start is a new action with a new key', async () => {
    const api = fakeApi({ post: (n) => (n === 1 ? problem(429, 'EXPORT_QUOTA_REACHED') : json(200, exportState('ready'))) });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    expect(await screen.findByText('Too many exports are being built, or too many were asked for today. Try again later.')).toBeInTheDocument();
    expect(api.saved).toEqual([]);
    await user.click(start());
    await screen.findByText(/^Downloaded /);
    const [first, second] = api.posts();
    expect(first!.headers['idempotency-key']).not.toBe(second!.headers['idempotency-key']);
  });

  it('shows why a failed export failed, and starts a new export (a new key) when asked again', async () => {
    let n = 0;
    const api = fakeApi({
      post: () => json(200, exportState('queued', { id: ID })),
      poll: () => (n++ === 0 ? json(200, exportState('failed', { error: 'the file could not be written.' })) : json(200, exportState('ready'))),
    });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    expect(await screen.findByText('The export could not be built: the file could not be written. Start it again.', {}, { timeout: 3000 })).toBeInTheDocument();
    await user.click(start());
    await screen.findByText(/^Downloaded /, {}, { timeout: 3000 });
    const [first, second] = api.posts();
    expect(first!.headers['idempotency-key']).not.toBe(second!.headers['idempotency-key']);
  });

  it('retries the same action with the same key when the answer was lost, so no second export is made', async () => {
    // Three tries fail on the network (the builder's own retries), then the member presses Start again.
    const lost = () => new TypeError('Failed to fetch');
    const api = fakeApi({ post: (n) => (n <= 3 ? lost() : json(200, exportState('ready'))) });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    expect(await screen.findByText('The server cannot be reached. Check your connection and try again.', {}, { timeout: 5000 })).toBeInTheDocument();
    await user.click(start());
    await screen.findByText(/^Downloaded /);
    const keys = api.posts().map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
  }, 15_000);

  it('a changed request is a new action, even after a lost answer', async () => {
    const api = fakeApi({ post: (n) => (n <= 3 ? new TypeError('Failed to fetch') : json(200, exportState('ready'))) });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    await screen.findByText('The server cannot be reached. Check your connection and try again.', {}, { timeout: 5000 });
    await user.click(screen.getByRole('radio', { name: /Excel/ }));
    await user.click(start());
    await screen.findByText(/^Downloaded /);
    const keys = api.posts().map((c) => c.headers['idempotency-key']);
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
  }, 15_000);

  it('stops waiting when the dialog is closed: no further poll is made', async () => {
    const api = fakeApi({ post: () => json(200, exportState('queued')), poll: () => json(200, exportState('running')) });
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.click(start());
    await screen.findByText('Waiting for the export to start…');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(api.calls.filter((c) => c.path === `/v1/exports/${ID}`)).toHaveLength(0);
    expect(api.saved).toEqual([]);
  });
});
