import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FormDefinition, PurposeId } from '@form/schema';
import { useSessionStore, type Me } from '@/auth/client';
import { NotificationsPanel } from '@/components/settings/NotificationsPanel';
import { block, formWith } from '@/test/fixtures';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = 'test';
const NOW = '2026-11-02T09:30:00.000Z';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail = '', extra: Record<string, unknown> = {}) => json(status, { type: 'about:blank', title: code, status, code, detail, ...extra });

/** The form the panel reads purposes and fields from: a name, an email, a section break and a paragraph, two purposes. */
function draft(): FormDefinition {
  const form = formWith([
    block('short_text', 'name', { label: 'Full name' }),
    block('email', 'contact', { label: 'Contact email' }),
    block('section_break', 'sb', { config: { name: 'Section A' } }),
    block('paragraph', 'intro'),
  ]);
  return {
    ...form,
    privacy: {
      ...form.privacy,
      purposes: [
        { ...form.privacy.purposes[0]!, id: 'p1' as PurposeId, name: 'Handle the enquiry' },
        { ...form.privacy.purposes[0]!, id: 'p2' as PurposeId, name: 'Send updates' },
      ],
    },
  };
}

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const owner = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  name: 'New response',
  kind: 'owner',
  enabled: true,
  trigger: 'submitted',
  to: [{ kind: 'role', role: 'form_owner' }],
  purposeIds: ['p1'],
  subject: ['New response'],
  body: { type: 'email_doc', content: [paragraph('Someone submitted the form.'), { type: 'answersTable', attrs: { include: 'all', hideEmpty: true, maskSensitive: true } }] },
  locale: 'respondent',
  includeWithdrawalLink: false,
  ...over,
});
const view = (config: Record<string, unknown>, rev = 3, warnings: unknown[] = []) => ({ id: config.id, formId: FORM, rev, config, warnings, createdAt: NOW, updatedAt: NOW });
const sender = (id: string, name: string, verifiedAt: string | null = NOW) => ({
  id,
  name,
  fromAddress: `${id}@acme.test`,
  fromName: null,
  verifiedAt,
  smtp: null,
  lastTestError: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const member = (userId: string, email: string, role = 'editor', status = 'active') => ({ userId, email, name: null, role, status, joinedAt: NOW });

interface Options {
  items?: Array<ReturnType<typeof view>>;
  senders?: ReturnType<typeof sender>[];
  members?: ReturnType<typeof member>[];
  missing?: boolean;
  /** What a create or a save answers instead of success. */
  refuse?: (method: string, body: Record<string, unknown>) => Response | null;
  /** The next save loses to someone else's. */
  stale?: boolean;
}

/**
 * The API behind the panel as far as the panel talks to it: the form's notifications (a save needs the right `If-Match`, as
 * the real one does), the org's senders and members, and the form's draft.
 */
function fakeApi(o: Options = {}) {
  const calls: Call[] = [];
  const items = new Map((o.items ?? []).map((n) => [String(n.id), n]));
  let stale = o.stale ?? false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = (typeof init.body === 'string' ? JSON.parse(init.body) : undefined) as Record<string, unknown> | undefined;
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ method, path: url, headers, body });
      if (url === '/v1/email-senders') return Promise.resolve(json(200, { items: o.senders ?? [sender('s1', 'Acme mail')] }));
      if (url === '/v1/org/members') return Promise.resolve(json(200, { items: o.members ?? [member('u1', 'asha@example.test', 'owner'), member('u2', 'ravi@example.test'), member('u3', 'gone@example.test', 'editor', 'suspended')], accessLinks: false }));
      if (o.missing) return Promise.resolve(problem(404, 'NOT_FOUND', 'That form is not in this organisation.'));
      if (url === `/v1/forms/${FORM}/draft`) return Promise.resolve(json(200, { draftRev: 3, schemaVersion: 2, draft: draft(), updatedAt: NOW, updatedBy: 'u1' }));
      if (url === `/v1/forms/${FORM}/notifications` && method === 'GET') return Promise.resolve(json(200, { items: [...items.values()] }));
      if (url === `/v1/forms/${FORM}/notifications` && method === 'POST') {
        const refused = o.refuse?.(method, body ?? {});
        if (refused) return Promise.resolve(refused);
        const made = view({ ...body, id: 'n-new' }, 1);
        items.set('n-new', made);
        return Promise.resolve(json(201, made));
      }
      const one = new RegExp(`^/v1/forms/${FORM}/notifications/([^/]+)$`).exec(url);
      if (one && method === 'PUT') {
        const id = one[1]!;
        const current = items.get(id);
        if (!current) return Promise.resolve(problem(404, 'NOT_FOUND'));
        if (stale) {
          // Someone else saved first: the stored revision moved on.
          stale = false;
          items.set(id, { ...current, rev: current.rev + 1, config: { ...current.config, name: 'Renamed elsewhere' } });
          return Promise.resolve(problem(409, 'NOTIFICATION_REV_CONFLICT', 'The notification changed since you read it.'));
        }
        if (headers['if-match'] !== `"${current.rev}"`) return Promise.resolve(problem(409, 'NOTIFICATION_REV_CONFLICT'));
        const refused = o.refuse?.(method, body ?? {});
        if (refused) return Promise.resolve(refused);
        const saved = view(body ?? {}, current.rev + 1);
        items.set(id, saved);
        return Promise.resolve(json(200, saved));
      }
      if (one && method === 'DELETE') {
        items.delete(one[1]!);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return {
    calls,
    called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
    saved: () => calls.filter((c) => (c.method === 'POST' || c.method === 'PUT') && c.path.startsWith(`/v1/forms/${FORM}/notifications`)),
  };
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <NotificationsPanel formId={FORM} />
    </MemoryRouter>,
  );

const save = () => screen.getByRole('button', { name: 'Save email' });

/** The purposes box of the open editor. */
const purposes = () => screen.getByRole('group', { name: 'Purposes' });

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('NotificationsPanel', () => {
  it('lists the form’s emails with their type and state, and says so when there are none', async () => {
    fakeApi({ items: [view(owner()), view(owner({ id: 'n2', name: 'Thank you', kind: 'autoresponder', enabled: false, to: [{ kind: 'field', blockId: 'contact' }] }))] });
    renderPanel();
    expect(await screen.findByText('New response')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('To your team');
    expect(rows[0]).toHaveTextContent('On');
    expect(rows[1]).toHaveTextContent('Thank you');
    expect(rows[1]).toHaveTextContent('To the respondent');
    expect(rows[1]).toHaveTextContent('Off');
  });

  it('says there is nothing yet for a form with no emails', async () => {
    fakeApi();
    renderPanel();
    expect(await screen.findByText(/No emails yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add an email to your team' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add a reply to the respondent' })).toBeEnabled();
  });

  it('keeps Save off until a purpose is ticked, then creates the email without choosing its id', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));

    expect(save()).toBeDisabled();
    expect(within(purposes()).getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(screen.getByText('Tick at least one purpose to save.')).toBeInTheDocument();

    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));
    expect(save()).toBeEnabled();
    await user.click(save());

    expect(await screen.findByText('Email saved.')).toBeInTheDocument();
    const [post] = api.called('POST', `/v1/forms/${FORM}/notifications`);
    expect(post?.headers).toMatchObject({ 'x-fr-org': 'o1' });
    // The server makes the id; the client sends none.
    expect(post?.body).not.toHaveProperty('id');
    expect(post?.body).toMatchObject({ kind: 'owner', enabled: true, trigger: 'submitted', purposeIds: ['p1'], to: [{ kind: 'role', role: 'form_owner' }], locale: 'respondent' });
    // Saved: nothing to save until something changes, and unticking the only purpose turns Save off again.
    expect(save()).toBeDisabled();
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));
    expect(save()).toBeDisabled();
    expect(screen.getByText('Tick at least one purpose to save.')).toBeInTheDocument();
  });

  it('shows a 422 MISSING_PURPOSE next to the purposes, and takes it away when the purposes change', async () => {
    fakeApi({ refuse: () => problem(422, 'MISSING_PURPOSE', 'The form does not declare this purpose: p9.') });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Send updates' }));
    await user.click(save());

    const alert = await within(purposes()).findByRole('alert');
    expect(alert).toHaveTextContent('The form does not declare this purpose: p9.');
    // It is about the purposes, not a banner: nothing else shows an alert.
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));
    expect(within(purposes()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a 403 data.route refusal next to the recipients', async () => {
    fakeApi({ refuse: () => problem(403, 'DATA_ROUTE_FORBIDDEN', 'Saving this email would route answers to a recipient outside the people who may read answers (/to/1), which needs the data.route permission.') });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'auditor@elsewhere.test');
    await user.click(screen.getByRole('button', { name: 'Add address' }));
    await user.click(save());

    const recipients = screen.getByRole('group', { name: 'Recipients' });
    const alert = await within(recipients).findByRole('alert');
    expect(alert).toHaveTextContent('needs the data.route permission');
    // The purposes are fine: the refusal is not shown there.
    expect(within(purposes()).queryByRole('alert')).not.toBeInTheDocument();
    // The form stays as typed, so the author can remove the address and save again.
    expect(within(recipients).getByText('auditor@elsewhere.test')).toBeInTheDocument();
    await user.click(within(recipients).getByRole('button', { name: 'Remove auditor@elsewhere.test' }));
    expect(within(recipients).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a mistyped address before it is added', async () => {
    fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Add address' }));
    expect(screen.getByText('That is not an email address.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove not-an-address' })).not.toBeInTheDocument();
  });

  it('offers only fields that hold an answer in the subject’s insert-field menu, and inserts a pipe', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));

    await user.click(screen.getByRole('combobox', { name: 'Insert a field into the subject' }));
    // The form also has a section break and a paragraph: they hold no answer, so they are not offered.
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Full name', 'Contact email']);
    await user.click(screen.getByRole('option', { name: 'Full name' }));

    const subject = screen.getByRole('group', { name: 'Email subject' });
    expect(within(subject).getByRole('button', { name: 'Remove Full name from the subject' })).toBeInTheDocument();
    await user.click(save());
    await screen.findByText('Email saved.');
    expect(api.called('POST', `/v1/forms/${FORM}/notifications`)[0]?.body).toMatchObject({
      subject: ['New response', { pipe: { source: { kind: 'answer', blockId: 'name' } } }],
    });
  });

  it('puts the inserted field where the caret was in the subject, and takes it out again', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add an email to your team' }));
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));

    const text = screen.getByRole('textbox', { name: 'Subject' });
    // "New response" with the caret after "New ".
    await user.click(text);
    (text as HTMLInputElement).setSelectionRange(4, 4);
    await user.click(screen.getByRole('combobox', { name: 'Insert a field into the subject' }));
    await user.click(await screen.findByRole('option', { name: 'Contact email' }));
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('New ');
    expect(screen.getByRole('textbox', { name: 'Subject, part 2' })).toHaveValue('response');

    await user.click(screen.getByRole('button', { name: 'Remove Contact email from the subject' }));
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('New response');
    expect(screen.queryByRole('textbox', { name: 'Subject, part 2' })).not.toBeInTheDocument();
    await user.click(save());
    await screen.findByText('Email saved.');
    expect(api.saved()[0]?.body).toMatchObject({ subject: ['New response'] });
  });

  it('adds and removes the answers table node with the toggle', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a reply to the respondent' }));
    await user.click(within(purposes()).getByRole('checkbox', { name: 'Handle the enquiry' }));

    // A reply to the respondent starts without the table; the autoresponder's recipient is the form's email field.
    const toggle = screen.getByRole('switch', { name: 'Include answers table' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Respondent’s email field' })).toHaveTextContent('Contact email');

    await user.click(toggle);
    expect(toggle).toBeChecked();
    await user.click(save());
    await screen.findByText('Email saved.');
    const created = api.saved()[0]?.body as { body: { content: Array<{ type: string; attrs?: unknown }> }; to: unknown };
    expect(created.to).toEqual([{ kind: 'field', blockId: 'contact' }]);
    expect(created.body.content.filter((n) => n.type === 'answersTable')).toEqual([{ type: 'answersTable', attrs: { include: 'all', hideEmpty: true, maskSensitive: true } }]);
    // The text stays editable in the rich-text editor beside the table.
    expect(created.body.content[0]).toMatchObject({ type: 'paragraph' });

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await user.click(save());
    await waitFor(() => expect(api.saved()).toHaveLength(2));
    const resaved = api.saved()[1];
    // The first save made the email, so this one saves it at the revision the server answered: a PUT, not a second email.
    expect(resaved).toMatchObject({ method: 'PUT', path: `/v1/forms/${FORM}/notifications/n-new`, headers: { 'if-match': '"1"' } });
    const resavedBody = (resaved as Call).body as { body: { content: Array<{ type: string }> } };
    expect(resavedBody.body.content.map((n) => n.type)).toEqual(['paragraph']);
  });

  it('offers only the form’s email fields for an autoresponder', async () => {
    fakeApi();
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a reply to the respondent' }));
    await user.click(screen.getByRole('combobox', { name: 'Respondent’s email field' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Contact email']);
  });

  it('edits a saved email: the sender, whether it is on, and the members and groups it goes to, saved at its revision', async () => {
    const api = fakeApi({ items: [view(owner(), 7)], senders: [sender('s1', 'Acme mail'), sender('s2', 'Billing', null)] });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit New response' }));

    expect(save()).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('New response');
    expect(screen.getByRole('combobox', { name: 'Send from' })).toHaveTextContent('The platform’s own sender');

    await user.click(screen.getByRole('combobox', { name: 'Send from' }));
    await user.click(await screen.findByRole('option', { name: 'Billing (s2@acme.test)' }));
    // A sender that has never delivered a test message is said to be untested.
    expect(screen.getByText(/has not delivered a test message yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Send this email' }));

    // Only active members are offered, and the ones already added are not.
    await user.click(screen.getByRole('combobox', { name: 'Add a member' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['asha@example.test', 'ravi@example.test']);
    await user.click(screen.getByRole('option', { name: 'ravi@example.test' }));
    await user.click(screen.getByRole('combobox', { name: 'Add a group' }));
    await user.click(await screen.findByRole('option', { name: 'The organisation’s owners and admins' }));

    await user.click(save());
    expect(await screen.findByText('Email saved.')).toBeInTheDocument();
    const [put] = api.called('PUT', `/v1/forms/${FORM}/notifications/n1`);
    expect(put?.headers['if-match']).toBe('"7"');
    expect(put?.body).toMatchObject({
      id: 'n1',
      enabled: false,
      senderId: 's2',
      to: [{ kind: 'role', role: 'form_owner' }, { kind: 'member', userId: 'u2' }, { kind: 'role', role: 'org_admins' }],
    });
    expect(save()).toBeDisabled();

    // Back to the platform sender: the key is left out, not sent empty.
    await user.click(screen.getByRole('combobox', { name: 'Send from' }));
    await user.click(await screen.findByRole('option', { name: 'The platform’s own sender' }));
    await user.click(save());
    await waitFor(() => expect(api.called('PUT', `/v1/forms/${FORM}/notifications/n1`)).toHaveLength(2));
    const second = api.called('PUT', `/v1/forms/${FORM}/notifications/n1`)[1];
    expect(second?.headers['if-match']).toBe('"8"');
    expect(second?.body).not.toHaveProperty('senderId');
  });

  it('on a stale revision says so, saves nothing, and Reload brings back the server’s version', async () => {
    const api = fakeApi({ items: [view(owner(), 2)], stale: true });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit New response' }));
    await user.click(screen.getByRole('switch', { name: 'Send this email' }));
    await user.click(save());

    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed elsewhere'));
    expect(screen.getByRole('switch', { name: 'Send this email' })).toBeChecked();
    expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument();
    expect(api.called('GET', `/v1/forms/${FORM}/notifications`)).toHaveLength(2);
  });

  it('shows the warnings the server found, such as a field the form no longer has', async () => {
    fakeApi({ items: [view(owner(), 2, [{ code: 'unknown_merge_tag_block', path: '/subject/1', blockId: 'gone', message: 'This email uses a field that is not in the form any more; that part is left empty.' }])] });
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit New response' }));
    expect(screen.getByText('Things to fix in this email')).toBeInTheDocument();
    expect(screen.getByText(/not in the form any more/)).toBeInTheDocument();
  });

  it('deletes an email after asking', async () => {
    const api = fakeApi({ items: [view(owner())] });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Delete New response' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “New response”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.called('DELETE', `/v1/forms/${FORM}/notifications/n1`)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete New response' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete email' }));
    expect(await screen.findByText('Email deleted.')).toBeInTheDocument();
    expect(api.called('DELETE', `/v1/forms/${FORM}/notifications/n1`)).toHaveLength(1);
    expect(screen.queryByText('New response')).not.toBeInTheDocument();
  });

  it('says so when the form is not on the server yet, and sends nothing else', async () => {
    const api = fakeApi({ missing: true });
    renderPanel();
    expect(await screen.findByText(/not on the server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add an email to your team' })).not.toBeInTheDocument();
    expect(api.saved()).toHaveLength(0);
  });

  it('asks to sign in when there is no session', () => {
    useSessionStore.setState({ status: 'signed_out' }, true);
    const api = fakeApi();
    renderPanel();
    expect(screen.getByText('Sign in to set up this form’s emails.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});
