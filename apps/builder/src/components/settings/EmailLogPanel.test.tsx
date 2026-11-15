import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore, type Me } from '@/auth/client';
import { EmailLogPanel } from '@/components/settings/EmailLogPanel';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

const FORM = 'test';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
const problem = (status: number, code: string, detail = '') => json(status, { type: 'about:blank', title: code, status, code, detail });

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  notificationId: 'n1',
  submissionId: `s-${id}`,
  role: 'to',
  to: ['a***@example.com'],
  status: 'sent',
  attempts: 1,
  lastError: null,
  sentAt: '2026-11-02T09:31:00.000Z',
  createdAt: '2026-11-02T09:30:00.000Z',
  ...over,
});

/**
 * The API behind the panel: the form's email log in pages (the cursor is passed back as it came, and a status filter is part
 * of what the cursor is for) and its notifications, for the names.
 */
function fakeApi(o: { pages?: Array<{ items: unknown[]; nextCursor: string | null }>; forbidden?: boolean } = {}) {
  const paths: string[] = [];
  const pages = o.pages ?? [{ items: [], nextCursor: null }];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      paths.push(url);
      if (url === `/v1/forms/${FORM}/notifications`) {
        return Promise.resolve(json(200, { items: [{ id: 'n1', formId: FORM, rev: 1, config: notificationConfig, warnings: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }] }));
      }
      if (url.startsWith(`/v1/forms/${FORM}/email-log`)) {
        if (o.forbidden) return Promise.resolve(problem(403, 'FORBIDDEN', 'Requires submissions.read.'));
        const query = new URL(url, 'http://x').searchParams;
        const cursor = query.get('cursor');
        const status = query.get('status');
        const index = cursor ? Number(/^page-(\d+)$/.exec(cursor)?.[1]) : 0;
        const page = pages[index] ?? { items: [], nextCursor: null };
        // The status filter is the API's: only the emails with that status, on a page of their own.
        return Promise.resolve(json(200, status ? { items: page.items.filter((m) => (m as { status: string }).status === status), nextCursor: null } : page));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND'));
    }),
  );
  return { logPaths: () => paths.filter((p) => p.includes('/email-log')) };
}

const notificationConfig = {
  id: 'n1',
  name: 'New response',
  kind: 'owner',
  enabled: true,
  trigger: 'submitted',
  to: [],
  purposeIds: ['p1'],
  subject: ['New response'],
  body: { type: 'email_doc', content: [] },
  locale: 'respondent',
  includeWithdrawalLink: false,
};

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('EmailLogPanel', () => {
  it('shows the masked recipients, the status and the attempts of each email, and what the mail server said', async () => {
    fakeApi({
      pages: [
        {
          items: [
            message('m1', { to: ['a***@example.com', 'r***@example.org'], status: 'sent', attempts: 1 }),
            message('m2', { to: ['b***@example.net'], role: 'cc', status: 'failed', attempts: 5, lastError: 'Mailbox unavailable', sentAt: null }),
            message('m3', { notificationId: 'n-deleted', status: 'retrying', attempts: 2, sentAt: null, lastError: 'Connection timed out' }),
          ],
          nextCursor: null,
        },
      ],
    });
    render(<EmailLogPanel formId={FORM} />);

    const table = await screen.findByRole('table', { name: 'Emails sent for this form' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    const [sent, failed, retrying] = rows;
    // Addresses are shown as the worker stored them: masked, never in full.
    expect(sent).toHaveTextContent('New response');
    expect(sent).toHaveTextContent('a***@example.com, r***@example.org');
    expect(within(sent!).getByText('Sent')).toBeInTheDocument();
    expect(within(sent!).getAllByRole('cell')[4]).toHaveTextContent('1');
    expect(sent).toHaveTextContent(/^.*Sent .*2026.*$/);

    expect(failed).toHaveTextContent('b***@example.net');
    expect(failed).toHaveTextContent('(cc)');
    expect(within(failed!).getByText('Failed')).toBeInTheDocument();
    expect(within(failed!).getAllByRole('cell')[4]).toHaveTextContent('5');
    expect(failed).toHaveTextContent('Mailbox unavailable');

    expect(retrying).toHaveTextContent('A deleted email');
    expect(within(retrying!).getByText('Retrying')).toBeInTheDocument();
    expect(within(retrying!).getAllByRole('cell')[4]).toHaveTextContent('2');
    expect(retrying).toHaveTextContent('Connection timed out');
  });

  it('says so when nothing has been sent', async () => {
    fakeApi();
    render(<EmailLogPanel formId={FORM} />);
    expect(await screen.findByText(/No emails yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an older page when asked, with the cursor as the API sent it, and stops at the last page', async () => {
    const api = fakeApi({
      pages: [
        { items: [message('m1')], nextCursor: 'page-1' },
        { items: [message('m2', { to: ['z***@example.com'] })], nextCursor: null },
      ],
    });
    const user = userEvent.setup();
    render(<EmailLogPanel formId={FORM} />);
    await screen.findByText('a***@example.com');
    expect(api.logPaths()).toEqual([`/v1/forms/${FORM}/email-log?limit=50`]);

    await user.click(screen.getByRole('button', { name: 'Show older emails' }));
    expect(await screen.findByText('z***@example.com')).toBeInTheDocument();
    // The first page stays, the next is appended, and there is nothing further to ask for.
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
    expect(api.logPaths()[1]).toBe(`/v1/forms/${FORM}/email-log?limit=50&cursor=page-1`);
    expect(screen.queryByRole('button', { name: 'Show older emails' })).not.toBeInTheDocument();
  });

  it('filters by status from the first page again', async () => {
    const api = fakeApi({ pages: [{ items: [message('m1')], nextCursor: 'page-1' }] });
    const user = userEvent.setup();
    render(<EmailLogPanel formId={FORM} />);
    await screen.findByText('a***@example.com');
    await user.click(screen.getByRole('combobox', { name: 'Show emails that are' }));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    await waitFor(() => expect(api.logPaths()).toContain(`/v1/forms/${FORM}/email-log?limit=50&status=failed`));
    expect(await screen.findByText('No emails with that status.')).toBeInTheDocument();
  });

  it('says why the log is closed to a member who may not read responses', async () => {
    fakeApi({ forbidden: true });
    render(<EmailLogPanel formId={FORM} />);
    expect(await screen.findByText(/needs permission to read responses/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
