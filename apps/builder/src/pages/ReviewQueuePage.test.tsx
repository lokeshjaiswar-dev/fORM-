import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore } from '@/auth/client';
import { ME, fakeReviewApi, json, problem, type FakeReviewApi } from '@/components/review/fakeReviewApi';
import { responseLink } from '@/components/review/links';
import { ReviewQueuePage } from '@/pages/ReviewQueuePage';
import type { QueueItem } from '@/persistence/reviewsApi';

const LOAN = '0196f0a0-0000-7000-8000-0000000000a1';
const LEAVE = '0196f0a0-0000-7000-8000-0000000000a2';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  submissionId: '0196f0a0-0000-7000-8000-0000000000b1',
  formId: LOAN,
  formTitle: 'Loan application',
  unitId: 'u_id',
  unitName: 'Identity check',
  round: 1,
  order: 1,
  required: true,
  receivedAt: '2026-11-14T10:00:00.000Z',
  ageSeconds: 2 * 86_400 + 3600,
  ...over,
});

const ITEMS: QueueItem[] = [
  item(),
  item({ submissionId: '0196f0a0-0000-7000-8000-0000000000b2', unitId: 'u_amount', unitName: 'Amount check', required: false, round: 2, ageSeconds: 5 * 3600 }),
  item({ submissionId: '0196f0a0-0000-7000-8000-0000000000b3', formId: LEAVE, formTitle: 'Leave request', unitId: 'u_manager', unitName: 'Manager approval', ageSeconds: 30 }),
];

/** The queue as the API filters it: by form, unit and how long it has waited. */
const queueOf = (path: string) => {
  const q = new URL(path, 'http://x').searchParams;
  const days = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }[q.get('age') ?? ''] ?? 0;
  const items = ITEMS.filter((i) => (!q.get('formId') || i.formId === q.get('formId')) && (!q.get('unitId') || i.unitId === q.get('unitId')) && i.ageSeconds >= days * 86_400);
  return { items, nextCursor: null };
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reviews']}>
      <ReviewQueuePage />
    </MemoryRouter>,
  );
}

const queueCalls = (api: FakeReviewApi) => api.to('GET', /^\/v1\/reviews\/queue/);
const list = () => screen.getByRole('list', { name: 'Units waiting for your review' });

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ReviewQueuePage (WP-2.33)', () => {
  it('renders the queue items from the API: unit, form, how long they have waited, and whether they are required', async () => {
    const api = fakeReviewApi({ queue: (_n, call) => queueOf(call.path) });
    renderPage();

    expect(screen.getByRole('heading', { name: 'Review queue' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to forms' })).toHaveAttribute('href', '/forms');
    expect(await screen.findByRole('link', { name: 'Identity check · Loan application' })).toBeInTheDocument();

    const rows = within(list()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Waiting 2 days')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Required')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Waiting 5 hours')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Optional')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Round 2')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Waiting less than a minute')).toBeInTheDocument();
    expect(queueCalls(api)).toHaveLength(1);
    expect(queueCalls(api)[0]?.path).toBe('/v1/reviews/queue?limit=50');
  });

  it('links each row to its response on the form’s Responses page, opened', async () => {
    fakeReviewApi({ queue: (_n, call) => queueOf(call.path) });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Manager approval · Leave request' });
    expect(link).toHaveAttribute('href', `/forms/${LEAVE}/responses?response=0196f0a0-0000-7000-8000-0000000000b3`);
    expect(responseLink({ formId: 'a/b', submissionId: 'c d' })).toBe('/forms/a%2Fb/responses?response=c%20d');
  });

  it('filters by form: the API is asked for that form, only its units are listed, and the other forms stay in the picker', async () => {
    const api = fakeReviewApi({ queue: (_n, call) => queueOf(call.path) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Manager approval · Leave request' });

    const form = screen.getByRole('combobox', { name: 'Form' });
    expect(within(form).getAllByRole('option').map((o) => o.textContent)).toEqual(['All forms', 'Loan application', 'Leave request']);
    await user.selectOptions(form, 'Leave request');

    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Manager approval · Leave request' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Identity check · Loan application' })).not.toBeInTheDocument();
    expect(queueCalls(api).at(-1)?.path).toBe(`/v1/reviews/queue?limit=50&formId=${LEAVE}`);
    // Both forms are still offered, so the member can switch without clearing the filter first.
    expect(within(screen.getByRole('combobox', { name: 'Form' })).getAllByRole('option')).toHaveLength(3);
  });

  it('filters by unit and by how long the response has waited, narrows the unit picker to the chosen form, and clears all filters', async () => {
    const api = fakeReviewApi({ queue: (_n, call) => queueOf(call.path) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Identity check · Loan application' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'Amount check');
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(1));
    expect(queueCalls(api).at(-1)?.path).toBe('/v1/reviews/queue?limit=50&unitId=u_amount');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'All units');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Waiting for' }), 'At least 1 day');
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Identity check · Loan application' })).toBeInTheDocument();
    expect(queueCalls(api).at(-1)?.path).toBe('/v1/reviews/queue?limit=50&age=1d');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Form' }), 'Leave request');
    expect(await screen.findByText('Nothing waiting matches these filters.')).toBeInTheDocument();
    // The form's own units are the only ones offered, and the unit picked for another form is dropped.
    expect(within(screen.getByRole('combobox', { name: 'Unit' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['All units', 'Manager approval']);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(3));
    expect(queueCalls(api).at(-1)?.path).toBe('/v1/reviews/queue?limit=50');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('says nothing is waiting when the queue is empty', async () => {
    fakeReviewApi();
    renderPage();
    expect(await screen.findByText('Nothing is waiting for your review.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Units waiting for your review' })).not.toBeInTheDocument();
  });

  it('shows a failed read with a way to try again, in plain words', async () => {
    const api = fakeReviewApi({ queue: (n) => (n === 1 ? problem(403, 'FORBIDDEN', 'Requires submissions.review.') : { items: [item()], nextCursor: null }) });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role in this organisation does not allow that.');
    expect(screen.queryByText(/Requires submissions.review/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Identity check · Loan application' })).toBeInTheDocument();
    expect(queueCalls(api)).toHaveLength(2);
  });

  it('pages by the API’s cursor, passes it back as it came, and does not list a unit twice', async () => {
    const first = item();
    const second = item({ submissionId: '0196f0a0-0000-7000-8000-0000000000b9', unitName: 'Older check', unitId: 'u_old' });
    const api = fakeReviewApi({
      queue: (n) => (n === 1 ? { items: [first], nextCursor: 'signed.cursor' } : { items: [first, second], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Identity check · Loan application' });
    await user.click(screen.getByRole('button', { name: 'Show more' }));

    expect(await screen.findByRole('link', { name: 'Older check · Loan application' })).toBeInTheDocument();
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
    expect(queueCalls(api)[1]?.path).toBe('/v1/reviews/queue?limit=50&cursor=signed.cursor');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('starts again from the top when the API no longer accepts the cursor, and says so when more cannot be loaded', async () => {
    const api = fakeReviewApi({
      queue: (n) => {
        if (n === 1) return { items: [item()], nextCursor: 'old' };
        if (n === 2) return problem(400, 'INVALID_CURSOR');
        if (n === 3) return { items: [item()], nextCursor: 'newer' };
        return new TypeError('network down');
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Identity check · Loan application' });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(queueCalls(api)).toHaveLength(3));
    expect(queueCalls(api)[2]?.path).toBe('/v1/reviews/queue?limit=50');

    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('More could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Identity check · Loan application' })).toBeInTheDocument();
  });

  it('drops the answer to an older request when the filters have moved on', async () => {
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const api = fakeReviewApi({
      queue: (n, call) => (n === 1 ? slow.then(() => json(200, { items: ITEMS, nextCursor: null })) : queueOf(call.path)),
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(queueCalls(api)).toHaveLength(1));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Waiting for' }), 'At least 1 day');
    await screen.findByRole('link', { name: 'Identity check · Loan application' });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The slow, unfiltered answer did not replace the filtered list.
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
  });
});
