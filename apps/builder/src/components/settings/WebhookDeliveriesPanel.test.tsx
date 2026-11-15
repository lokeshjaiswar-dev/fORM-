import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore, type Me } from '@/auth/client';
import { WebhookDeliveriesPanel } from '@/components/settings/WebhookDeliveriesPanel';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = '01970000-0000-7000-8000-00000000f001';
const HOOK = '01970000-0000-7000-8000-0000000000a1';
const LOG = `/v1/forms/${FORM}/webhooks/${HOOK}/deliveries`;

type Row = {
  id: string;
  webhookId: string;
  event: string;
  submissionId: string | null;
  status: 'pending' | 'retrying' | 'succeeded' | 'failed' | 'dead';
  attempt: number;
  httpStatus: number | null;
  durationMs: number | null;
  responseSnippet: string | null;
  replayOf: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

let seq = 0;
const delivery = (over: Partial<Row> = {}): Row => {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    id: `01970000-0000-7000-8000-00000000${n}`,
    webhookId: HOOK,
    event: 'submission.created',
    submissionId: '01970000-0000-7000-8000-0000000000b1',
    status: 'succeeded',
    attempt: 1,
    httpStatus: 200,
    durationMs: 120,
    responseSnippet: null,
    replayOf: null,
    nextAttemptAt: null,
    createdAt: `2026-11-15T10:${String(seq).padStart(2, '0')}:00.000Z`,
    ...over,
  };
};

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail = '') => json(status, { type: 'about:blank', title: code, status, code, detail });

interface Options {
  /** The log, newest first. */
  rows?: Row[];
  /** Rows per page, to make a second page. */
  pageSize?: number;
  forbidden?: boolean;
  /** Answers a replay instead of the default. */
  replay?: (original: Row) => Response;
  /** The server cannot be reached for the log. */
  down?: boolean;
}

/**
 * The delivery routes as the real API answers them: newest first, a page and a cursor, a status filter, and a replay that
 * adds a new row naming the original (a replay of a replay names the first).
 */
function fakeApi(o: Options = {}) {
  const calls: Call[] = [];
  let rows = o.rows ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (o.down) return Promise.reject(new TypeError('network down'));
      if (o.forbidden) return Promise.resolve(problem(403, 'FORBIDDEN', 'Requires data.route.'));
      const [path = '', query = ''] = url.split('?');
      const params = new URLSearchParams(query);
      if (path === LOG && method === 'GET') {
        const wanted = params.get('status');
        const all = rows.filter((r) => !wanted || r.status === wanted);
        const size = o.pageSize ?? Number(params.get('limit') ?? 50);
        const start = params.get('cursor') ? Number(params.get('cursor')) : 0;
        const page = all.slice(start, start + size);
        return Promise.resolve(json(200, { items: page, nextCursor: start + size < all.length ? String(start + size) : null }));
      }
      const replay = /^\/v1\/forms\/[^/]+\/webhooks\/[^/]+\/deliveries\/([^/]+)\/replay$/.exec(path);
      if (replay && method === 'POST') {
        const original = rows.find((r) => r.id === replay[1]);
        if (!original) return Promise.resolve(problem(404, 'NOT_FOUND', 'That delivery is not in this webhook’s log.'));
        if (o.replay) return Promise.resolve(o.replay(original));
        const again = delivery({ event: original.event, submissionId: original.submissionId, status: 'pending', attempt: 0, httpStatus: null, durationMs: null, replayOf: original.replayOf ?? original.id });
        rows = [again, ...rows];
        return Promise.resolve(json(201, again));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

beforeEach(() => {
  seq = 0;
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

/** The data rows of the log (the header row is not one). */
const bodyRows = () => within(screen.getByRole('table', { name: 'Deliveries of this webhook, newest first' })).getAllByRole('row').slice(1);

describe('WebhookDeliveriesPanel: the log', () => {
  it('lists the deliveries newest first with their status, the receiver’s answer, the timing and the try', async () => {
    const older = delivery({ status: 'succeeded', httpStatus: 200, durationMs: 85, responseSnippet: 'ok' });
    const failed = delivery({ status: 'retrying', attempt: 2, httpStatus: 500, durationMs: 1500, responseSnippet: 'upstream error', nextAttemptAt: '2026-11-15T11:00:00.000Z' });
    const dead = delivery({ status: 'dead', attempt: 4, httpStatus: null, durationMs: null });
    const api = fakeApi({ rows: [dead, failed, older] });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);

    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    const [first, second, third] = bodyRows();
    expect(first).toHaveTextContent('Gave up');
    expect(first).toHaveTextContent('No answer');
    expect(second).toHaveTextContent('Retrying');
    expect(second).toHaveTextContent('HTTP 500');
    expect(second).toHaveTextContent('1,500 ms');
    expect(second).toHaveTextContent('upstream error');
    expect(second).toHaveTextContent('Next try');
    expect(third).toHaveTextContent('Delivered');
    expect(third).toHaveTextContent('HTTP 200');
    expect(third).toHaveTextContent('A response is submitted');
    // The first read is a page of fifty for this webhook, in this org, and no cursor.
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: `${LOG}?limit=50` });
    expect(api.calls[0]?.headers['x-fr-org']).toBe('o1');
  });

  it('marks a replay as one and says nothing has been sent when the log is empty', async () => {
    const original = delivery();
    const replay = delivery({ status: 'pending', attempt: 0, httpStatus: null, durationMs: null, replayOf: original.id });
    fakeApi({ rows: [replay, original] });
    const first = render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(bodyRows()[0]).toHaveTextContent('A replay of an earlier delivery');
    expect(bodyRows()[0]).toHaveTextContent('Waiting');
    expect(bodyRows()[1]).not.toHaveTextContent('A replay');
    first.unmount();

    fakeApi({ rows: [] });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    expect(await screen.findByText('Nothing has been sent to this address yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('loads older deliveries with the cursor and lists each once', async () => {
    const rows = [delivery(), delivery(), delivery(), delivery(), delivery()].reverse();
    const api = fakeApi({ rows, pageSize: 2 });
    const user = userEvent.setup();
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Show older deliveries' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(api.calls[1]?.path).toBe(`${LOG}?limit=50&cursor=2`);
    await user.click(screen.getByRole('button', { name: 'Show older deliveries' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(5));
    // The last page has no cursor, so there is nothing more to ask for.
    expect(screen.queryByRole('button', { name: 'Show older deliveries' })).not.toBeInTheDocument();
  });

  it('shows only the deliveries with the chosen status', async () => {
    const api = fakeApi({ rows: [delivery({ status: 'failed', httpStatus: 502 }), delivery({ status: 'succeeded' })] });
    const user = userEvent.setup();
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Failed');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(bodyRows()[0]).toHaveTextContent('HTTP 502');
    expect(api.calls.at(-1)?.path).toBe(`${LOG}?limit=50&status=failed`);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Waiting');
    expect(await screen.findByText('No delivery has this status.')).toBeInTheDocument();
  });
});

describe('WebhookDeliveriesPanel: replay', () => {
  it('calls POST …/replay for the row pressed and shows the new row after the refresh', async () => {
    const original = delivery({ status: 'failed', attempt: 4, httpStatus: 503, durationMs: 900 });
    const api = fakeApi({ rows: [original] });
    const user = userEvent.setup();
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));

    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay the delivery of “A response is submitted” from / }));

    // The replay is the POST for that delivery, with the org and the client header an unsafe call needs, and no body to trust.
    await waitFor(() => expect(api.called('POST', `${LOG}/${original.id}/replay`)).toHaveLength(1));
    const [post] = api.called('POST', `${LOG}/${original.id}/replay`);
    expect(post?.headers['x-fr-org']).toBe('o1');
    expect(post?.headers['x-fr-client']).toBe('builder');
    expect(post?.body).toEqual({});

    // The log is read again, and the new delivery is its newest row: waiting to be sent, marked as a replay of the first.
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(bodyRows()[0]).toHaveTextContent('Waiting');
    expect(bodyRows()[0]).toHaveTextContent('A replay of an earlier delivery');
    expect(bodyRows()[1]).toHaveTextContent('Failed');
    expect(bodyRows()[1]).toHaveTextContent('HTTP 503');
    expect(screen.getByText('Queued to send again. It is the newest row below.')).toBeInTheDocument();
    expect(api.called('GET', `${LOG}?limit=50`)).toHaveLength(2);
  });

  it('can replay the replay too, and the refresh button reads the log again', async () => {
    const api = fakeApi({ rows: [delivery()] });
    const user = userEvent.setup();
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ }));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ }));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);

    const before = api.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.calls.length).toBe(before + 1));
  });

  it('keeps the log and says why when the webhook is switched off (409 WEBHOOK_DISABLED)', async () => {
    const original = delivery();
    fakeApi({ rows: [original], replay: () => problem(409, 'WEBHOOK_DISABLED', 'Switch the webhook on before sending a delivery again.') });
    const user = userEvent.setup();
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ }));
    expect(await screen.findByText('Switch the webhook on to send a delivery again.')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(1);
    // The button is usable again, for when the webhook is on.
    expect(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ })).toBeEnabled();
  });

  it('does not offer Replay for a webhook that is off, and sends nothing', async () => {
    const api = fakeApi({ rows: [delivery()] });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} enabled={false} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ })).toBeDisabled();
    expect(screen.getByText('Switch the webhook on to send a delivery again.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('says a replay could not be queued when the server cannot do it, and renders the permission state when the role has no data.route', async () => {
    fakeApi({ rows: [delivery()], replay: () => problem(503, 'SERVICE_UNAVAILABLE', 'Deliveries cannot be queued on this server yet.') });
    const user = userEvent.setup();
    const first = render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ }));
    expect(await screen.findByText('This server cannot do that yet. Try again later.')).toBeInTheDocument();
    first.unmount();

    fakeApi({ rows: [delivery()], replay: () => problem(403, 'FORBIDDEN', 'Requires data.route.') });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Replay/ }));
    expect(await screen.findByText('You need the data routing permission')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('WebhookDeliveriesPanel: refusals', () => {
  it('renders the missing-permission state when the log answers 403', async () => {
    fakeApi({ forbidden: true });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You need the data routing permission');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Replay/ })).not.toBeInTheDocument();
  });

  it('says so, with a retry, when the server cannot be reached', async () => {
    fakeApi({ down: true });
    render(<WebhookDeliveriesPanel formId={FORM} webhookId={HOOK} />);
    const alert = await screen.findByText('The server cannot be reached. Check your connection and try again.');
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
