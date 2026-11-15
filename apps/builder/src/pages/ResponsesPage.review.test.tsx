import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useSessionStore } from '@/auth/client';
import { FORM, ME, SUB, decidedJson, detailJson, fakeReviewApi, json, type FakeReviewApi } from '@/components/review/fakeReviewApi';
import { formatWhen } from '@/components/responses/format';
import { ResponsesPage } from '@/pages/ResponsesPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository, MemorySubmissions, block, formWith } from '@/test/fixtures';

/*
 * The Responses page with a response that waits for review (WP-2.33): the queue links here with `?response=<id>`, the pane
 * shows the decision panel, and a decision that settles the response changes the status in the grid without reading it again.
 */

const OTHER = '0196f0a0-0000-7000-8000-0000000000e2';
const FAR = '0196f0a0-0000-7000-8000-0000000000e9';

const row = (id: string, name: string, status: string, minute: number) => ({
  id,
  receivedAt: new Date(Date.UTC(2026, 10, 15, 10, 0) - minute * 60_000).toISOString(),
  status,
  read: true,
  starred: false,
  archivedAt: null,
  trashedAt: null,
  versionNumber: 2,
  cells: { b_name: name },
  masked: [],
});

const ROWS = [row(SUB, 'Ravi Kumar', 'pending_review', 0), row(OTHER, 'Meera Shah', 'complete', 1)];
const COLUMNS = [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text' }];

let status = 'pending_review';

function setup(): FakeReviewApi {
  status = 'pending_review';
  return fakeReviewApi({
    detail: () => detailJson({ submission: { ...detailJson().submission, status } }),
    decide: () => {
      status = 'complete';
      return json(200, decidedJson('u_id', { submissionStatus: 'complete' }));
    },
    other: (call) => {
      const path = call.path.split('?')[0];
      if (call.method === 'GET' && path === `/v1/forms/${FORM}/submissions`) return { columns: COLUMNS, items: ROWS.map((r) => (r.id === SUB ? { ...r, status } : r)), nextCursor: null };
      if (call.method === 'GET' && path === `/v1/forms/${FORM}/submissions/${SUB}`) {
        return { ...ROWS[0], formId: FORM, locale: 'en-IN', status, fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: 'Plain Reading', masked: false }], files: [], review: [{ name: 'Identity check', state: 'pending' }] };
      }
      if (call.method === 'GET' && path === `/v1/forms/${FORM}/submissions/${FAR}`) {
        return { ...ROWS[0], id: FAR, formId: FORM, locale: 'en-IN', status: 'complete', fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: 'Far Away', masked: false }], files: [] };
      }
      if (call.method === 'GET' && path === `/v1/forms/${FORM}/submissions/${OTHER}`) {
        return { ...ROWS[1], formId: FORM, locale: 'en-IN', fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: 'Meera Shah', masked: false }], files: [] };
      }
      return undefined;
    },
  });
}

function renderPage(at = `/forms/${FORM}/responses`) {
  const repo = new MemoryRepository();
  void repo.save(newStoredForm(FORM, '2026-11-15T04:30:00.000Z', { ...formWith([block('short_text', 'q', { label: 'Question' })]), title: 'Loan application' }));
  return render(
    <RepositoryProvider repo={repo}>
      <SubmissionsProvider repo={new MemorySubmissions()}>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/forms/:id/responses" element={<ResponsesPage />} />
          </Routes>
        </MemoryRouter>
      </SubmissionsProvider>
    </RepositoryProvider>,
  );
}

const grid = () => screen.getByRole('table', { name: 'Responses' });
const findGrid = () => screen.findByRole('table', { name: 'Responses' });
const gridReads = (api: FakeReviewApi) => api.to('GET', new RegExp(`^/v1/forms/${FORM}/submissions\\?`));

// jsdom has no layout: give the grid a viewport, as ResponsesPage.test does.
const restore: Array<() => void> = [];
beforeAll(() => {
  for (const [name, value] of Object.entries({ clientHeight: 440, clientWidth: 1200 })) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    restore.push(() => (original ? Object.defineProperty(HTMLElement.prototype, name, original) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]));
  }
  return () => restore.forEach((undo) => undo());
});

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('ResponsesPage and a response under review (WP-2.33)', () => {
  it('labels a held response "Under review" in the grid', async () => {
    setup();
    renderPage();
    const cell = await within(await findGrid()).findByText('Under review');
    expect(cell.closest('[role="row"]')).toHaveTextContent('Ravi Kumar');
    expect(within(grid()).getByText('Complete')).toBeInTheDocument();
  });

  it('opens the response the address names, with its review units, under the status "Under review"', async () => {
    setup();
    renderPage(`/forms/${FORM}/responses?response=${SUB}`);
    const pane = await screen.findByRole('complementary', { name: 'Response' });
    expect(await within(pane).findByRole('heading', { name: 'Identity check' })).toBeInTheDocument();
    expect(within(pane).getByText(/Under review · v2 · en-IN/)).toBeInTheDocument();
  });

  it('opens a response from the address even when its row is not among the rows loaded, without previous and next', async () => {
    const api = setup();
    renderPage(`/forms/${FORM}/responses?response=${FAR}`);
    const pane = await screen.findByRole('complementary', { name: 'Response' });
    expect(await within(pane).findByText('Far Away')).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: 'Previous response' })).toBeDisabled();
    expect(within(pane).getByRole('button', { name: 'Next response' })).toBeDisabled();
    // It was not held for review, so no review is asked for.
    expect(api.to('GET', /\/review$/)).toHaveLength(0);
  });

  it('moving to another response from the grid replaces the one the address named', async () => {
    setup();
    const user = userEvent.setup();
    renderPage(`/forms/${FORM}/responses?response=${FAR}`);
    await screen.findByRole('complementary', { name: 'Response' });
    await findGrid();
    await user.click(within(within(grid()).getByText('Meera Shah').closest<HTMLElement>('[role="row"]')!).getByRole('button', { name: new RegExp(`^${formatWhen(ROWS[1]!.receivedAt)}`) }));
    expect(await screen.findByText('Meera Shah', { selector: 'dd *, dd' })).toBeInTheDocument();
    expect(screen.queryByText('Far Away')).not.toBeInTheDocument();
  });

  it('shows the new status in the grid when a decision settles the open response, without reading the grid again', async () => {
    const api = setup();
    const user = userEvent.setup();
    renderPage(`/forms/${FORM}/responses?response=${SUB}`);
    await within(await findGrid()).findByText('Under review');
    const reads = gridReads(api).length;

    const pane = screen.getByRole('complementary', { name: 'Response' });
    await user.click(await within(pane).findByRole('button', { name: 'Approve Identity check' }));

    await waitFor(() => expect(within(grid()).queryByText('Under review')).not.toBeInTheDocument());
    expect(within(grid()).getAllByText('Complete')).toHaveLength(2);
    expect(within(pane).getByText(/Complete · v2 · en-IN/)).toBeInTheDocument();
    expect(gridReads(api)).toHaveLength(reads);
  });
});
