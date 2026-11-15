import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore, type Me } from '@/auth/client';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = '01970000-0000-7000-8000-00000000f001';
const HOOK = '01970000-0000-7000-8000-0000000000a1';
const NEW_HOOK = '01970000-0000-7000-8000-0000000000a2';
const OPS = 'purpose_ops';
const MARKETING = 'purpose_marketing';
const SECRET = 'whsec_Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC1zZWNyZXQ';
const ROTATED_SECRET = 'whsec_bmV3LXNlY3JldC1mb3ItdGhlLXJvdGF0ZS10ZXN0LW9u';

/** The form as the server's draft holds it: two purposes and two fields (the editor offers what the draft declares). */
const DRAFT = {
  privacy: { purposes: [{ id: OPS, name: 'Order handling' }, { id: MARKETING, name: 'Marketing' }] },
  pages: [{ id: 'p1', children: ['b_name', 'b_email'] }],
  blocks: {
    b_name: { id: 'b_name', type: 'short_text', key: 'full_name', label: ['Full name'], compliance: { classification: 'personal' }, config: {} },
    b_email: { id: 'b_email', type: 'email', key: 'email', label: ['Email address'], compliance: { classification: 'personal' }, config: {} },
  },
};

type Row = {
  id: string;
  formId: string;
  url: string;
  enabled: boolean;
  events: string[];
  keyBy: 'key' | 'id';
  fieldKeys: string[] | 'all_in_purposes';
  purposeIds: string[];
  files: 'signed_urls' | 'none';
  secretHint: string;
  secretRotatedAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
};

const hook = (over: Partial<Row> = {}): Row => ({
  id: HOOK,
  formId: FORM,
  url: 'https://hooks.example.com/form',
  enabled: true,
  events: ['submission.created'],
  keyBy: 'key',
  fieldKeys: 'all_in_purposes',
  purposeIds: [OPS],
  files: 'none',
  secretHint: 'a1b2',
  secretRotatedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  rev: 2,
  createdAt: '2026-11-10T08:00:00.000Z',
  updatedAt: '2026-11-10T08:00:00.000Z',
  ...over,
});

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail: string) => json(status, { type: 'about:blank', title: code, status, code, detail });

interface Options {
  webhooks?: Row[];
  /** Every webhook route answers 403, as for a role without `data.route`. */
  forbidden?: boolean;
  /** The form is not on the server (404 for its webhooks). */
  missing?: boolean;
  /** Refuses a create or a save with this answer. */
  refuse?: (body: Record<string, unknown>) => Response | null;
  /** The next save loses to someone else's. */
  stale?: boolean;
  draft?: unknown;
}

/** The API behind the tab as far as the tab talks to it: the form's draft, its webhooks (a save needs the right `If-Match`, as the real one does) and the one-time secrets. */
function fakeApi(o: Options = {}) {
  const calls: Call[] = [];
  let items = o.webhooks ?? [];
  let stale = o.stale ?? false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, headers: (init.headers ?? {}) as Record<string, string>, body });
      const root = `/v1/forms/${FORM}`;
      if (url === `${root}/draft`) return Promise.resolve(json(200, { draftRev: 3, schemaVersion: 2, draft: o.draft ?? DRAFT, updatedAt: '2026-11-10T08:00:00.000Z', updatedBy: null }));
      if (!url.startsWith(`${root}/webhooks`)) return Promise.resolve(problem(404, 'NOT_FOUND', 'Not here.'));
      if (o.forbidden) return Promise.resolve(problem(403, 'FORBIDDEN', 'Requires data.route.'));
      if (o.missing) return Promise.resolve(problem(404, 'NOT_FOUND', 'That form is not in this organisation.'));
      const rest = url.slice(`${root}/webhooks`.length);
      if (rest === '' && method === 'GET') return Promise.resolve(json(200, { items }));
      if (rest === '' && method === 'POST') {
        const refused = o.refuse?.(body as Record<string, unknown>);
        if (refused) return Promise.resolve(refused);
        const row = hook({ ...(body as Partial<Row>), id: NEW_HOOK, rev: 1, secretHint: SECRET.slice(-4) });
        items = [...items, row];
        return Promise.resolve(json(201, { ...row, secret: SECRET }));
      }
      const id = /^\/([^/]+)/.exec(rest)?.[1];
      const row = items.find((w) => w.id === id);
      if (!row) return Promise.resolve(problem(404, 'NOT_FOUND', 'That webhook is not on this form.'));
      if (/^\/[^/]+$/.test(rest) && method === 'PUT') {
        const refused = o.refuse?.(body as Record<string, unknown>);
        if (refused) return Promise.resolve(refused);
        if (stale) {
          stale = false;
          return Promise.resolve(problem(409, 'WEBHOOK_REV_CONFLICT', 'The webhook changed since you read it.'));
        }
        if ((init.headers as Record<string, string>)['if-match'] !== `"${row.rev}"`) return Promise.resolve(problem(409, 'WEBHOOK_REV_CONFLICT', 'The webhook changed since you read it.'));
        const saved = { ...row, ...(body as Partial<Row>), rev: row.rev + 1 };
        items = items.map((w) => (w.id === row.id ? saved : w));
        return Promise.resolve(json(200, saved));
      }
      if (/^\/[^/]+$/.test(rest) && method === 'DELETE') {
        items = items.filter((w) => w.id !== row.id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (rest.endsWith('/rotate-secret') && method === 'POST') {
        const rotated = { ...row, secretHint: ROTATED_SECRET.slice(-4), secretRotatedAt: '2026-11-15T09:00:00.000Z' };
        items = items.map((w) => (w.id === row.id ? rotated : w));
        return Promise.resolve(json(200, { secret: ROTATED_SECRET, secretHint: rotated.secretHint, secretRotatedAt: rotated.secretRotatedAt }));
      }
      if (rest.endsWith('/deliveries') && method === 'GET') return Promise.resolve(json(200, { items: [], nextCursor: null }));
      return Promise.resolve(problem(404, 'NOT_FOUND', 'Not here.'));
    }),
  );
  return { calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

/**
 * Whether `needle` is held anywhere in the state or the props of the components that are on screen now: every hook of
 * every fiber of the current tree, and the props they were last given. DOM nodes are not looked inside (that is what the
 * page shows, which the tests check separately), and a fiber's other copy (React keeps the previous render's until it is
 * reused) is not part of the tree.
 */
function holds(container: HTMLElement, needle: string): boolean {
  const key = Object.keys(container).find((k) => k.startsWith('__reactContainer$'));
  if (!key) throw new Error('This is not a React root.');
  const hostRoot = (container as unknown as Record<string, { stateNode: { current: unknown } }>)[key]!;
  const seen = new Set<unknown>();
  const inside = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string') return value.includes(needle);
    if (typeof value !== 'object' || value === null || depth > 10 || seen.has(value)) return false;
    if (typeof Node !== 'undefined' && value instanceof Node) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    // A React element: its props are what it renders with; its owner is the fiber that made it.
    if ('$$typeof' in record) return inside(record.props, depth + 1);
    // A fiber reached through a ref or an effect is walked from the root, not from here.
    if ('stateNode' in record && 'return' in record) return false;
    return Object.values(record).some((v) => typeof v !== 'function' && inside(v, depth + 1));
  };
  const walk = (fiber: { child: unknown; sibling: unknown; memoizedState: unknown; memoizedProps: unknown } | null): boolean => {
    for (let f = fiber; f; f = f.sibling as typeof fiber) {
      if (inside(f.memoizedState, 0) || inside(f.memoizedProps, 0) || walk(f.child as typeof fiber)) return true;
    }
    return false;
  };
  return walk(hostRoot.stateNode.current as Parameters<typeof walk>[0]);
}

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

/** The text of a webhook's detail row, by its term: `Purposes`, `Sent when`, … */
const detail = (item: HTMLElement, term: string): string | null => within(item).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? null;

const url = () => screen.getByRole('textbox', { name: 'Address' });
const save = () => screen.getByRole('button', { name: 'Create webhook' });

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add webhook' }));
  expect(await screen.findByRole('heading', { name: 'Add a webhook' })).toBeInTheDocument();
}

describe('WebhooksPanel: the list', () => {
  it('lists the form’s webhooks with their events, purposes and the end of the secret, and shows no secret', async () => {
    const api = fakeApi({ webhooks: [hook(), hook({ id: NEW_HOOK, url: 'https://other.example.org/in', enabled: false, disabledReason: 'Turned off automatically after 50 failed deliveries in a row.', fieldKeys: ['email'], events: ['submission.created', 'submission.updated'], purposeIds: [OPS, MARKETING], secretRotatedAt: '2026-11-12T09:00:00.000Z' })] });
    render(<WebhooksPanel formId={FORM} />);

    const list = await screen.findByRole('list', { name: 'Webhooks of this form' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('https://hooks.example.com/form');
    expect(first).toHaveTextContent('On');
    expect(detail(first!, 'Sent when')).toBe('A response is submitted');
    expect(detail(first!, 'Purposes')).toBe('Order handling');
    expect(detail(first!, 'Fields')).toBe('Every field covered by the purposes');
    expect(detail(first!, 'Signing secret')).toBe('Ends in a1b2');
    expect(second).toHaveTextContent('Off');
    expect(second).toHaveTextContent('Switched off: Turned off automatically after 50 failed deliveries in a row.');
    expect(detail(second!, 'Sent when')).toBe('A response is submitted, A response is edited');
    expect(detail(second!, 'Purposes')).toBe('Order handling, Marketing');
    expect(detail(second!, 'Fields')).toBe('1 picked field');
    expect(detail(second!, 'Signing secret')).toMatch(/^Ends in a1b2 \(replaced .+\)$/);
    // The reads name the org and ask for the form's webhooks and its draft (for the purposes), nothing else.
    expect(api.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([`GET /v1/forms/${FORM}/draft`, `GET /v1/forms/${FORM}/webhooks`].sort());
    expect(api.called('GET', `/v1/forms/${FORM}/webhooks`)[0]?.headers['x-fr-org']).toBe('o1');
    expect(document.body.textContent).not.toContain('whsec_');
  });

  it('says there are none yet, with the way to add one and the link to the signature recipe', async () => {
    fakeApi();
    render(<WebhooksPanel formId={FORM} />);
    expect(await screen.findByText('No webhooks yet. Add one to send each response to your own system.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add webhook' })).toBeInTheDocument();
    const recipe = screen.getByRole('link', { name: 'How to check a webhook’s signature' });
    expect(recipe).toHaveAttribute('href', expect.stringContaining('webhook-signatures.md'));
    expect(recipe).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('says a form that is not on the server yet cannot have webhooks, and offers a retry when the server cannot be reached', async () => {
    fakeApi({ missing: true });
    const first = render(<WebhooksPanel formId={FORM} />);
    expect(await screen.findByText(/This form is not on the server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add webhook' })).not.toBeInTheDocument();
    first.unmount();

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network down'))));
    render(<WebhooksPanel formId={FORM} />);
    expect(await screen.findByText('The server cannot be reached. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('WebhooksPanel: the editor', () => {
  it('keeps Save off without a purpose (and without an address or an event), and turns it on when there is one of each', async () => {
    fakeApi();
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);

    // The form's own purposes are offered, none is chosen for the member, and the way forward is said.
    expect(screen.getByRole('checkbox', { name: 'Order handling' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Marketing' })).not.toBeChecked();
    expect(screen.getByText('Choose at least one purpose.')).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.type(url(), 'https://hooks.example.com/form');
    expect(save()).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    expect(save()).toBeEnabled();
    expect(screen.queryByText('Choose at least one purpose.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    expect(save()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));

    await user.click(screen.getByRole('checkbox', { name: 'A response is submitted' }));
    expect(screen.getByText('Choose at least one event.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'A response is submitted' }));
    expect(save()).toBeEnabled();

    // An address that is not a web address cannot be saved either.
    await user.clear(url());
    await user.type(url(), 'hooks.example.com');
    expect(save()).toBeDisabled();
  });

  it('tells a form with no purposes why none can be chosen', async () => {
    fakeApi({ draft: { ...DRAFT, privacy: { purposes: [] } } });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);
    expect(screen.getByText(/This form declares no purposes yet/)).toBeInTheDocument();
    await user.type(url(), 'https://hooks.example.com/form');
    expect(save()).toBeDisabled();
  });

  it('shows a 422 EGRESS_DENIED next to the address, keeps what was typed and adds nothing', async () => {
    const detail = 'That address is not a public internet address this server can reach. Private, loopback and link-local addresses, and names that do not resolve, are refused.';
    const api = fakeApi({ refuse: () => problem(422, 'EGRESS_DENIED', detail) });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);

    await user.type(url(), 'https://169.254.169.254/latest');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(save());

    await waitFor(() => expect(url()).toHaveAccessibleDescription(expect.stringContaining('not a public internet address')));
    expect(url()).toBeInvalid();
    expect(url()).toHaveValue('https://169.254.169.254/latest');
    expect(screen.getByRole('checkbox', { name: 'Order handling' })).toBeChecked();
    // Not next to the purposes, and the editor is still open (nothing was made, so nothing is listed and no secret is shown).
    expect(screen.getByRole('group', { name: 'Purposes' })).not.toHaveTextContent('not a public internet address');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Webhooks of this form' })).not.toBeInTheDocument();
    expect(api.called('POST', `/v1/forms/${FORM}/webhooks`)).toHaveLength(1);

    // Changing the address clears the message that was about it.
    await user.type(url(), '1');
    expect(url()).not.toHaveAccessibleDescription(expect.stringContaining('not a public internet address'));
  });

  it('shows a 422 MISSING_PURPOSE next to the purposes', async () => {
    const detail = 'The form does not declare the purpose "purpose_ops". Add it under the form’s privacy purposes first.';
    fakeApi({ refuse: () => problem(422, 'MISSING_PURPOSE', detail) });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);

    await user.type(url(), 'https://hooks.example.com/form');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(save());

    const purposes = await screen.findByRole('group', { name: 'Purposes' });
    await waitFor(() => expect(within(purposes).getByRole('alert')).toHaveTextContent(detail));
    expect(purposes).toHaveAccessibleDescription(expect.stringContaining('does not declare the purpose'));
    // Not next to the address.
    expect(url()).not.toHaveAccessibleDescription(expect.stringContaining('does not declare'));
    expect(url()).toHaveValue('https://hooks.example.com/form');
    // Ticking a purpose again clears it.
    await user.click(within(purposes).getByRole('checkbox', { name: 'Marketing' }));
    expect(within(purposes).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('creates a webhook with exactly what was chosen: the purposes, the picked fields and the key, and nothing the client does not decide', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);

    await user.type(url(), '  https://hooks.example.com/form ');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(screen.getByRole('checkbox', { name: 'Marketing' }));
    await user.click(screen.getByRole('checkbox', { name: 'A response is edited' }));
    await user.click(screen.getByRole('radio', { name: 'Only the fields I pick' }));
    expect(save()).toBeDisabled();
    expect(screen.getByText('Pick at least one field, or send every field covered by the purposes.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Email address (email)' }));
    await user.click(screen.getByRole('radio', { name: 'Field id' }));
    await user.click(save());

    await screen.findByRole('dialog');
    const [post] = api.called('POST', `/v1/forms/${FORM}/webhooks`);
    expect(post?.body).toEqual({
      url: 'https://hooks.example.com/form',
      enabled: true,
      events: ['submission.created', 'submission.updated'],
      keyBy: 'id',
      fieldKeys: ['email'],
      purposeIds: [OPS, MARKETING],
      files: 'none',
    });
    expect(post?.headers['x-fr-org']).toBe('o1');
    expect(post?.headers['x-fr-client']).toBe('builder');
  });
});

describe('WebhooksPanel: the one-time secret', () => {
  it('shows the secret from the create response once, and holds it nowhere in the page, its state or its storage after the dialog is closed', async () => {
    fakeApi();
    const user = userEvent.setup();
    const { container } = render(<WebhooksPanel formId={FORM} />);
    await openNew(user);
    await user.type(url(), 'https://hooks.example.com/form');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(save());

    // Shown, with the warning, a way to copy it and the recipe that checks it; the editor has closed.
    const dialog = await screen.findByRole('dialog', { name: 'Copy the signing secret now' });
    expect(within(dialog).getByLabelText('Signing secret')).toHaveValue(SECRET);
    expect(within(dialog).getByRole('button', { name: 'Copy secret' })).toBeInTheDocument();
    expect(within(dialog).getByText(/This is the only time the secret is shown/)).toBeInTheDocument();
    expect(within(dialog).getByText('For the webhook at hooks.example.com')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'How to check a webhook’s signature' })).toHaveAttribute('href', expect.stringContaining('webhook-signatures.md'));
    expect(screen.queryByRole('heading', { name: 'Add a webhook' })).not.toBeInTheDocument();
    // The scan can see it while it is meant to be there, so finding nothing afterwards means something.
    expect(holds(container, SECRET)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'I have saved it' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(holds(container, SECRET)).toBe(false);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    // The webhook is listed with the end of its secret, which is all the server will say about it.
    const item = within(await screen.findByRole('list', { name: 'Webhooks of this form' })).getByRole('listitem');
    expect(item).toHaveTextContent('https://hooks.example.com/form');
    expect(item).toHaveTextContent(`Ends in ${SECRET.slice(-4)}`);
  });

  it('does not close on a click outside, so the secret is not lost by accident; Escape closes it and clears it', async () => {
    fakeApi();
    const user = userEvent.setup();
    const { container } = render(<WebhooksPanel formId={FORM} />);
    await openNew(user);
    await user.type(url(), 'https://hooks.example.com/form');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(save());
    await screen.findByRole('dialog', { name: 'Copy the signing secret now' });

    // A press on the overlay behind the dialog, which closes most dialogs.
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);
    expect(screen.getByRole('dialog', { name: 'Copy the signing secret now' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(holds(container, SECRET)).toBe(false);
  });

  it('replaces the secret after a confirmation, shows the new one once and lists only its end', async () => {
    const api = fakeApi({ webhooks: [hook()] });
    const user = userEvent.setup();
    const { container } = render(<WebhooksPanel formId={FORM} />);

    await user.click(await screen.findByRole('button', { name: 'Replace the signing secret of the webhook at hooks.example.com' }));
    // Nothing is replaced until it is confirmed.
    const confirm = await screen.findByRole('dialog', { name: 'Replace the signing secret?' });
    expect(api.called('POST', `/v1/forms/${FORM}/webhooks/${HOOK}/rotate-secret`)).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Replace secret' }));

    const dialog = await screen.findByRole('dialog', { name: 'Copy the new signing secret now' });
    expect(api.called('POST', `/v1/forms/${FORM}/webhooks/${HOOK}/rotate-secret`)).toHaveLength(1);
    expect(within(dialog).getByLabelText('Signing secret')).toHaveValue(ROTATED_SECRET);
    expect(within(dialog).getByText(/The old secret stopped working/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'I have saved it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(ROTATED_SECRET);
    expect(holds(container, ROTATED_SECRET)).toBe(false);
    expect(screen.getByRole('listitem')).toHaveTextContent(`Ends in ${ROTATED_SECRET.slice(-4)}`);
    expect(screen.getByRole('listitem')).toHaveTextContent('replaced');
  });

  it('leaves the secret alone when the confirmation is cancelled', async () => {
    const api = fakeApi({ webhooks: [hook()] });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await user.click(await screen.findByRole('button', { name: 'Replace the signing secret of the webhook at hooks.example.com' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', `/v1/forms/${FORM}/webhooks/${HOOK}/rotate-secret`)).toHaveLength(0);
  });
});

describe('WebhooksPanel: no data routing permission', () => {
  it('renders the missing-permission state when the API answers 403, with nothing to add', async () => {
    fakeApi({ forbidden: true });
    render(<WebhooksPanel formId={FORM} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You need the data routing permission');
    expect(alert).toHaveTextContent('Ask an owner or admin of this organisation');
    expect(screen.queryByRole('button', { name: 'Add webhook' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Webhooks of this form' })).not.toBeInTheDocument();
    expect(screen.queryByText('No webhooks yet. Add one to send each response to your own system.')).not.toBeInTheDocument();
  });

  it('falls into the same state when a save is refused with 403 after the list was read', async () => {
    fakeApi({ refuse: () => problem(403, 'FORBIDDEN', 'Requires data.route.') });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await openNew(user);
    await user.type(url(), 'https://hooks.example.com/form');
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(save());
    expect(await screen.findByText('You need the data routing permission')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a webhook' })).not.toBeInTheDocument();
  });
});

describe('WebhooksPanel: changing and deleting', () => {
  it('saves a change against the revision it read and shows the saved webhook', async () => {
    const api = fakeApi({ webhooks: [hook({ rev: 4 })] });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await user.click(await screen.findByRole('button', { name: 'Edit the webhook at hooks.example.com' }));

    // The editor starts from the webhook as stored.
    expect(url()).toHaveValue('https://hooks.example.com/form');
    expect(screen.getByRole('checkbox', { name: 'Order handling' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Marketing' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Marketing' }));
    await user.click(screen.getByRole('switch', { name: 'Send responses to this address' }));
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));

    expect(await screen.findByText('Webhook saved.')).toBeInTheDocument();
    const [put] = api.called('PUT', `/v1/forms/${FORM}/webhooks/${HOOK}`);
    expect(put?.headers['if-match']).toBe('"4"');
    expect(put?.body).toEqual({
      url: 'https://hooks.example.com/form',
      enabled: false,
      events: ['submission.created'],
      keyBy: 'key',
      fieldKeys: 'all_in_purposes',
      purposeIds: [OPS, MARKETING],
      files: 'none',
    });
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Order handling, Marketing');
    expect(item).toHaveTextContent('Off');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a purpose the form no longer declares visible, so it can be unticked, and offers a reload when someone else saved first', async () => {
    const api = fakeApi({ webhooks: [hook({ purposeIds: ['purpose_gone'] })], stale: true });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await user.click(await screen.findByRole('button', { name: 'Edit the webhook at hooks.example.com' }));
    expect(screen.getByRole('checkbox', { name: 'purpose_gone (no longer declared in the form)' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Order handling' }));
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));

    expect(await screen.findByText(/This webhook was changed somewhere else/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    // The webhooks are read again, and the editor is closed.
    await screen.findByRole('list', { name: 'Webhooks of this form' });
    expect(screen.queryByRole('heading', { name: 'Change this webhook' })).not.toBeInTheDocument();
    expect(api.called('GET', `/v1/forms/${FORM}/webhooks`)).toHaveLength(2);
  });

  it('deletes a webhook only after a confirmation', async () => {
    const api = fakeApi({ webhooks: [hook()] });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await user.click(await screen.findByRole('button', { name: 'Delete the webhook at hooks.example.com' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this webhook?' });
    expect(api.called('DELETE', `/v1/forms/${FORM}/webhooks/${HOOK}`)).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('DELETE', `/v1/forms/${FORM}/webhooks/${HOOK}`)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete the webhook at hooks.example.com' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this webhook?' })).getByRole('button', { name: 'Delete webhook' }));
    expect(await screen.findByText('Webhook deleted.')).toBeInTheDocument();
    expect(api.called('DELETE', `/v1/forms/${FORM}/webhooks/${HOOK}`)).toHaveLength(1);
    expect(screen.queryByRole('list', { name: 'Webhooks of this form' })).not.toBeInTheDocument();
    expect(screen.getByText('No webhooks yet. Add one to send each response to your own system.')).toBeInTheDocument();
  });

  it('opens the delivery log of the webhook it was pressed on', async () => {
    const api = fakeApi({ webhooks: [hook()] });
    const user = userEvent.setup();
    render(<WebhooksPanel formId={FORM} />);
    await user.click(await screen.findByRole('button', { name: 'Delivery log of the webhook at hooks.example.com' }));
    expect(await screen.findByRole('region', { name: 'Delivery log' })).toBeInTheDocument();
    await waitFor(() => expect(api.called('GET', `/v1/forms/${FORM}/webhooks/${HOOK}/deliveries?limit=50`)).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Delivery log of the webhook at hooks.example.com' }));
    expect(screen.queryByRole('region', { name: 'Delivery log' })).not.toBeInTheDocument();
  });
});
