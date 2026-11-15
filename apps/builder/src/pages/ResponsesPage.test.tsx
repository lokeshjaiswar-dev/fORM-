import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiProblem } from '@/auth/client';
import { formatWhen } from '@/components/responses/format';
import { ResponsesPage } from '@/pages/ResponsesPage';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { newStoredForm } from '@/persistence/openForm';
import { MAX_BULK, PAGE_SIZE, type GridColumn, type GridRow } from '@/persistence/submissionsApi';
import { MemoryRepository, MemorySubmissions, block, formWith } from '@/test/fixtures';

const orgApi = vi.fn();
const loadSubmissionFile = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, orgApi: (...args: unknown[]) => orgApi(...args) };
});
vi.mock('@/persistence/filesApi', () => ({ loadSubmissionFile: (...args: unknown[]) => loadSubmissionFile(...args) }));

const FORM = 'f1';
const TOTAL = 120;
/** The columns of every version: `Legacy ref` exists in version 1 only. */
const COLUMNS: GridColumn[] = [
  { id: 'b_name', key: 'name', label: 'Name', type: 'short_text' },
  { id: 'b_city', key: 'city', label: 'City', type: 'short_text' },
  { id: 'b_ref', key: 'ref', label: 'Legacy ref', type: 'short_text' },
];

const idOf = (i: number) => `0196f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`;

/** Response `i`: newest first (so `Person 0` is the newest). The last twenty were received on version 1 and carry the legacy column. */
function makeRow(i: number): GridRow {
  return {
    id: idOf(i),
    receivedAt: new Date(Date.UTC(2026, 10, 15, 10, 0) - i * 60_000).toISOString(),
    status: i === 3 ? 'spam' : 'complete',
    read: i % 5 === 0,
    starred: false,
    archivedAt: null,
    trashedAt: null,
    versionNumber: i >= 100 ? 1 : 2,
    // A protected answer reaches the page as the API's mask, never as the answer.
    cells: { b_name: `Person ${i}`, b_city: i === 2 ? '••••••' : i === 7 ? 'Pune' : 'Delhi', ...(i >= 100 ? { b_ref: `OLD-${i}` } : {}) },
    masked: i === 2 ? ['b_city'] : [],
  };
}

/** What the API would keep: the responses and the files of one that has them. */
let store: GridRow[] = [];
let filesOf: Record<string, Array<Record<string, unknown>>> = {};
/** A flag to make the next call of a kind fail. */
let failNext: { match: RegExp; error: Error } | null = null;

const inView = (row: GridRow, view: string) =>
  view === 'trash' ? row.trashedAt !== null : row.trashedAt === null && (view === 'archived' ? row.archivedAt !== null : row.archivedAt === null);

/** The real API's grid, detail, patch and bulk contracts, over `store`; every answer is parsed with the schema the client sent, so a shape the page cannot read fails here. */
function serve(method: string, path: string, schema: z.ZodType | null, body?: { action?: string; ids?: string[]; read?: boolean; starred?: boolean }): unknown {
  if (failNext?.match.test(`${method} ${path}`)) {
    const { error } = failNext;
    failNext = null;
    throw error;
  }
  const url = new URL(path, 'http://x');
  const send = (value: unknown) => (schema ? schema.parse(JSON.parse(JSON.stringify(value))) : value);
  const bulk = /^\/v1\/forms\/[^/]+\/submissions\/bulk$/.test(url.pathname);
  const one = /^\/v1\/forms\/[^/]+\/submissions\/([^/]+)$/.exec(url.pathname)?.[1];

  if (method === 'GET' && !one) {
    const q = url.searchParams;
    const words = (q.get('q') ?? '').toLowerCase();
    const matching = store.filter(
      (row) =>
        inView(row, q.get('view') ?? 'inbox') &&
        (q.get('read') === null || row.read === (q.get('read') === 'true')) &&
        (q.get('starred') === null || row.starred === (q.get('starred') === 'true')) &&
        (q.get('status') === null || row.status === q.get('status')) &&
        (q.get('from') === null || row.receivedAt >= q.get('from')!) &&
        (q.get('to') === null || row.receivedAt <= q.get('to')!) &&
        (words === '' || Object.values(row.cells).some((cell) => cell.toLowerCase().includes(words))),
    );
    const start = Number(q.get('cursor')?.replace('c', '') ?? 0);
    const limit = Number(q.get('limit'));
    const items = matching.slice(start, start + limit);
    return send({ columns: COLUMNS, items, nextCursor: start + limit < matching.length ? `c${start + limit}` : null });
  }
  if (method === 'GET' && one) {
    const row = store.find((r) => r.id === one);
    if (!row) throw new ApiProblem(404, 'NOT_FOUND', 'That submission is not on this form.');
    return send({
      ...row,
      formId: FORM,
      versionId: idOf(900),
      locale: 'en-IN',
      meta: {},
      answers: {},
      fields: [
        { id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: row.cells.b_name ?? '', masked: false },
        { id: 'b_city', key: 'city', label: 'City', type: 'short_text', value: row.masked.includes('b_city') ? '••••••' : (row.cells.b_city ?? ''), masked: row.masked.includes('b_city') },
      ],
      files: filesOf[row.id] ?? [],
    });
  }
  if (method === 'PATCH' && one) {
    const row = store.find((r) => r.id === one);
    if (!row) throw new ApiProblem(404, 'NOT_FOUND', 'That submission is not on this form.');
    if (body?.read !== undefined) row.read = body.read;
    if (body?.starred !== undefined) row.starred = body.starred;
    return send({ id: row.id, read: row.read, starred: row.starred });
  }
  if (method === 'POST' && bulk) {
    const ids = new Set(body?.ids);
    const rows = store.filter((row) => ids.has(row.id));
    const now = '2026-11-15T12:00:00.000Z';
    if (body?.action === 'delete' && rows.some((row) => row.trashedAt === null)) {
      throw new ApiProblem(409, 'SUBMISSION_NOT_TRASHED', 'Only responses in the trash can be deleted forever');
    }
    for (const row of rows) {
      switch (body?.action) {
        case 'mark_read': row.read = true; break;
        case 'mark_unread': row.read = false; break;
        case 'star': row.starred = true; break;
        case 'unstar': row.starred = false; break;
        case 'archive': row.archivedAt = now; break;
        case 'unarchive': row.archivedAt = null; break;
        case 'trash': row.trashedAt = now; break;
        case 'restore': row.trashedAt = null; break;
      }
    }
    if (body?.action === 'delete') store = store.filter((row) => !ids.has(row.id));
    return send({ action: body?.action, requested: ids.size, changed: rows.length, unchanged: 0, missing: ids.size - rows.length, removedFiles: 0 });
  }
  throw new Error(`the fake API has no ${method} ${path}`);
}

/** The grid pages asked for so far, as their query parameters. */
const gridCalls = () =>
  orgApi.mock.calls
    .filter(([method, path]) => method === 'GET' && /\/submissions\?/.test(String(path)))
    .map(([, path]) => new URL(String(path), 'http://x').searchParams);
const callsTo = (method: string, pattern: RegExp) => orgApi.mock.calls.filter(([m, path]) => m === method && pattern.test(String(path)));
const lastGrid = () => gridCalls().at(-1);

/** The preview's rehearsal responses of this form, kept in this browser: the page must not show them. */
function rehearsals() {
  const previews = new MemorySubmissions();
  void previews.create({
    id: 'rehearsal-1',
    formId: FORM,
    submittedAt: '2026-11-15T09:00:00.000Z',
    answers: { q: { type: 'short_text', value: 'Rehearsal Person' } },
    fields: [{ key: 'q', label: 'Question', value: 'Rehearsal Person' }],
  });
  return previews;
}

function renderPage() {
  const repo = new MemoryRepository();
  void repo.save(newStoredForm(FORM, '2026-11-15T04:30:00.000Z', { ...formWith([block('short_text', 'q', { label: 'Question' })]), title: 'Feedback' }));
  return render(
    <RepositoryProvider repo={repo}>
      <SubmissionsProvider repo={rehearsals()}>
        <MemoryRouter initialEntries={[`/forms/${FORM}/responses`]}>
          <Routes>
            <Route path="/forms/:id/responses" element={<ResponsesPage />} />
          </Routes>
        </MemoryRouter>
      </SubmissionsProvider>
    </RepositoryProvider>,
  );
}

/** The row of a response, found by the name in its first answer column. */
const rowOf = (name: string): HTMLElement => {
  // Inside the table: the open response shows the same name in the pane.
  const row = within(screen.getByRole('table', { name: 'Responses' })).getByText(name).closest<HTMLElement>('[role="row"]');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};
const checkboxOf = (name: string) => within(rowOf(name)).getByRole('checkbox');
const table = () => screen.getByRole('table', { name: 'Responses' });

/** jsdom has no layout: give the grid a viewport of ten rows, and scroll it the way a member does. */
async function scrollGridTo(top: number) {
  const el = table();
  await act(async () => {
    el.scrollTop = top;
    fireEvent.scroll(el);
  });
}
const ROW_HEIGHT = 44;

const sizes = { clientHeight: 440, clientWidth: 1200 };
let restore: Array<() => void> = [];

beforeAll(() => {
  for (const [name, value] of Object.entries(sizes)) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    restore.push(() => (original ? Object.defineProperty(HTMLElement.prototype, name, original) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]));
  }
  return () => {
    for (const undo of restore) undo();
    restore = [];
  };
});

beforeEach(() => {
  store = Array.from({ length: TOTAL }, (_, i) => makeRow(i));
  filesOf = {};
  failNext = null;
  orgApi.mockReset();
  orgApi.mockImplementation(async (...args: Parameters<typeof serve>) => serve(...args));
  loadSubmissionFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResponsesPage', () => {
  describe('the grid', () => {
    it('renders the API columns, including one only version 1 had, and the first page of rows', async () => {
      renderPage();
      expect(await screen.findByText('Person 0')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Feedback' })).toBeInTheDocument();

      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
      expect(headers).toEqual(expect.arrayContaining(['Name', 'City', 'Legacy ref', 'Status', 'Version']));

      // One page was asked for, in the inbox, at the page size, with nothing else set.
      expect(gridCalls()).toHaveLength(1);
      expect(Object.fromEntries(lastGrid() ?? [])).toEqual({ view: 'inbox', limit: String(PAGE_SIZE) });
      // Only the rows on screen are drawn: 120 responses are not 120 rows.
      expect(screen.getAllByRole('row').length).toBeLessThan(30);
      expect(within(rowOf('Person 0')).getByText('Delhi')).toBeInTheDocument();
      expect(within(rowOf('Person 3')).getByText('Spam')).toBeInTheDocument();
      expect(within(rowOf('Person 0')).getByText('v2')).toBeInTheDocument();
    });

    it('marks the unread rows and shows a protected answer as its mask, with a lock that is named', async () => {
      renderPage();
      await screen.findByText('Person 0');
      expect(rowOf('Person 1')).toHaveAttribute('data-unread', 'true');
      expect(rowOf('Person 0')).not.toHaveAttribute('data-unread');
      const masked = within(rowOf('Person 2'));
      expect(masked.getByText('••••••')).toBeInTheDocument();
      expect(masked.getByRole('img', { name: /protected/ })).toBeInTheDocument();
    });

    it('loads the next page when the last rows come into view, and shows the answers of the later version', async () => {
      renderPage();
      await screen.findByText('Person 0');
      expect(gridCalls()).toHaveLength(1);

      await scrollGridTo(30 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(2));
      // The cursor the API signed comes back unchanged, with the same filters.
      expect(Object.fromEntries(lastGrid() ?? [])).toEqual({ view: 'inbox', limit: String(PAGE_SIZE), cursor: `c${PAGE_SIZE}` });

      await scrollGridTo(80 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(3));
      await scrollGridTo(112 * ROW_HEIGHT);
      expect(await screen.findByText('OLD-110')).toBeInTheDocument();
      expect(within(rowOf('Person 110')).getByText('v1')).toBeInTheDocument();
      // The last page had no next cursor: scrolling to the end asks for nothing more.
      await scrollGridTo(119 * ROW_HEIGHT);
      expect(gridCalls()).toHaveLength(3);
    });

    it('keeps the selection while pages load, and counts selected responses from every page', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 0'));
      await user.click(checkboxOf('Person 1'));
      expect(screen.getByRole('toolbar')).toHaveTextContent('2 responses selected');

      await scrollGridTo(30 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(2));
      await scrollGridTo(55 * ROW_HEIGHT);
      await user.click(checkboxOf('Person 56'));
      expect(screen.getByRole('toolbar')).toHaveTextContent('3 responses selected');

      // Back at the top the first two are still ticked, and the later page's one is still counted.
      await scrollGridTo(0);
      expect(checkboxOf('Person 0')).toBeChecked();
      expect(checkboxOf('Person 1')).toBeChecked();
      expect(checkboxOf('Person 2')).not.toBeChecked();
      expect(screen.getByRole('toolbar')).toHaveTextContent('3 responses selected');
    });

    it('selects every loaded response from the header, and clears the selection from the bar', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(screen.getByRole('checkbox', { name: 'Select all loaded responses' }));
      expect(screen.getByRole('toolbar')).toHaveTextContent(`${PAGE_SIZE} responses selected`);
      await user.click(screen.getByRole('button', { name: 'Clear selection' }));
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      expect(checkboxOf('Person 0')).not.toBeChecked();
    });

    it('stops a selection at what one bulk call may name, and says so', async () => {
      store = Array.from({ length: 600 }, (_, i) => makeRow(i));
      // Pages of 200, so the 600 responses are three calls.
      orgApi.mockImplementation(async (method: string, path: string, schema: z.ZodType | null, body?: Parameters<typeof serve>[3]) =>
        serve(method, String(path).replace(`limit=${PAGE_SIZE}`, 'limit=200'), schema, body),
      );
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await scrollGridTo(185 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(2));
      await scrollGridTo(385 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(3));

      await user.click(screen.getByRole('checkbox', { name: 'Select all loaded responses' }));
      expect(screen.getByRole('toolbar')).toHaveTextContent('500 responses selected');
      expect(screen.getByText(`You can select up to ${MAX_BULK} responses at a time.`)).toBeInTheDocument();

      // The first five hundred stay selected (the ones the member ticked first), and the call that follows names exactly them.
      await scrollGridTo(0);
      expect(checkboxOf('Person 0')).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Mark read' }));
      await waitFor(() => expect(callsTo('POST', /bulk$/)).toHaveLength(1));
      const sent = callsTo('POST', /bulk$/)[0]?.[3] as { ids: string[] };
      expect(sent.ids).toHaveLength(MAX_BULK);
    });
  });

  describe('search and filters', () => {
    it('asks for a search after a pause, not on every key, with the words as q', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.type(screen.getByRole('searchbox', { name: 'Search responses' }), 'Pune');
      // Four keys, one request (after the pause).
      await waitFor(() => expect(lastGrid()?.get('q')).toBe('Pune'));
      expect(gridCalls().filter((p) => p.has('q'))).toHaveLength(1);
      expect(await screen.findByText('Person 7')).toBeInTheDocument();
      expect(screen.queryByText('Person 0')).not.toBeInTheDocument();
    });

    it('sets from, to, read and starred from the controls, as ISO instants and booleans', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');

      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-15' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-16' } });
      await waitFor(() => expect(lastGrid()?.get('to')).toBe(new Date('2026-11-16T23:59:59.999').toISOString()));
      expect(lastGrid()?.get('from')).toBe(new Date('2026-11-15T00:00:00').toISOString());

      await user.selectOptions(screen.getByRole('combobox', { name: 'Read state' }), 'unread');
      await waitFor(() => expect(lastGrid()?.get('read')).toBe('false'));
      await user.selectOptions(screen.getByRole('combobox', { name: 'Read state' }), 'read');
      await waitFor(() => expect(lastGrid()?.get('read')).toBe('true'));

      await user.click(screen.getByRole('checkbox', { name: 'Starred only' }));
      await waitFor(() => expect(lastGrid()?.get('starred')).toBe('true'));

      await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'spam');
      await waitFor(() => expect(lastGrid()?.get('status')).toBe('spam'));
      expect(Object.fromEntries(lastGrid() ?? [])).toMatchObject({ view: 'inbox', read: 'true', starred: 'true', status: 'spam' });
    });

    it('says so when nothing matches, and Clear filters brings the list back', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.type(screen.getByRole('searchbox', { name: 'Search responses' }), 'nobody-here');
      expect(await screen.findByText('No responses match these filters.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(await screen.findByText('Person 0')).toBeInTheDocument();
      expect(lastGrid()?.has('q')).toBe(false);
    });

    it('does not ask for a range that ends before it starts', async () => {
      renderPage();
      await screen.findByText('Person 0');
      const before = gridCalls().length;
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-20' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-10' } });
      expect(await screen.findByText('The start date is after the end date.')).toBeInTheDocument();
      expect(gridCalls().slice(before).every((p) => !(p.get('from') && p.get('to')))).toBe(true);
    });

    it('starts each folder as its own list: the tabs ask for inbox, archived and trash, and drop the selection', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 0'));
      await user.click(screen.getByRole('tab', { name: 'Trash' }));
      expect(await screen.findByText('The trash is empty. Responses you move here can be restored or deleted forever.')).toBeInTheDocument();
      expect(lastGrid()?.get('view')).toBe('trash');
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: 'Archived' }));
      expect(await screen.findByText('Nothing is archived.')).toBeInTheDocument();
      expect(lastGrid()?.get('view')).toBe('archived');
      await user.click(screen.getByRole('tab', { name: 'Inbox' }));
      expect(await screen.findByText('Person 0')).toBeInTheDocument();
      expect(checkboxOf('Person 0')).not.toBeChecked();
    });

    it('moves between the tabs with the arrow keys', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      screen.getByRole('tab', { name: 'Inbox' }).focus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Archived' })).toHaveFocus();
      await user.keyboard('{End}');
      expect(screen.getByRole('tab', { name: 'Trash' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('bulk actions', () => {
    it('trash calls the bulk endpoint with the selected ids, takes the rows out of the inbox, and they are in the Trash tab', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 1'));
      await user.click(checkboxOf('Person 2'));
      await user.click(screen.getByRole('button', { name: 'Move to trash' }));

      await waitFor(() => expect(screen.queryByText('Person 1')).not.toBeInTheDocument());
      expect(callsTo('POST', /\/submissions\/bulk$/)).toEqual([['POST', `/v1/forms/${FORM}/submissions/bulk`, expect.anything(), { action: 'trash', ids: [idOf(1), idOf(2)] }]]);
      expect(screen.queryByText('Person 2')).not.toBeInTheDocument();
      expect(screen.getByText('Person 0')).toBeInTheDocument();
      expect(screen.getByText('2 responses moved to the trash.')).toBeInTheDocument();
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      // No new read of the page just to show the change.
      expect(gridCalls()).toHaveLength(1);

      await user.click(screen.getByRole('tab', { name: 'Trash' }));
      expect(await screen.findByText('Person 1')).toBeInTheDocument();
      expect(screen.getByText('Person 2')).toBeInTheDocument();
      expect(lastGrid()?.get('view')).toBe('trash');
    });

    it('marks read and unread and stars in place, so the rows stay where they are', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 1'));
      await user.click(screen.getByRole('button', { name: 'Mark read' }));
      await waitFor(() => expect(rowOf('Person 1')).not.toHaveAttribute('data-unread'));
      expect(callsTo('POST', /bulk$/)[0]?.[3]).toEqual({ action: 'mark_read', ids: [idOf(1)] });

      await user.click(checkboxOf('Person 1'));
      await user.click(screen.getByRole('button', { name: 'Star' }));
      await waitFor(() => expect(within(rowOf('Person 1')).getByRole('button', { name: /^Star response/ })).toHaveAttribute('aria-pressed', 'true'));

      await user.click(checkboxOf('Person 1'));
      await user.click(screen.getByRole('button', { name: 'Mark unread' }));
      await waitFor(() => expect(rowOf('Person 1')).toHaveAttribute('data-unread', 'true'));
    });

    it('archives out of the inbox, and the archive offers a way back to it', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 4'));
      await user.click(screen.getByRole('button', { name: 'Archive' }));
      await waitFor(() => expect(screen.queryByText('Person 4')).not.toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Archived' }));
      await user.click(await within(await screen.findByRole('table')).findByRole('checkbox', { name: /Select response received/ }));
      await user.click(screen.getByRole('button', { name: 'Move to inbox' }));
      expect(callsTo('POST', /bulk$/).map((c) => (c[3] as { action: string }).action)).toEqual(['archive', 'unarchive']);
    });

    it('offers only restore and delete forever in the Trash, and restore brings the rows back to the inbox', async () => {
      store[1]!.trashedAt = '2026-11-15T11:00:00.000Z';
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(screen.getByRole('tab', { name: 'Trash' }));
      await user.click(await within(await screen.findByRole('table')).findByRole('checkbox', { name: /Select response received/ }));
      const bar = screen.getByRole('toolbar');
      expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Restore', 'Delete forever', 'Clear selection']);
      await user.click(within(bar).getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText('The trash is empty. Responses you move here can be restored or deleted forever.')).toBeInTheDocument();
      expect(screen.getByText('1 response restored.')).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: 'Inbox' }));
      expect(await screen.findByText('Person 1')).toBeInTheDocument();
    });

    it('asks before deleting forever: Cancel deletes nothing, the confirmation sends the delete', async () => {
      store[1]!.trashedAt = '2026-11-15T11:00:00.000Z';
      store[2]!.trashedAt = '2026-11-15T11:00:00.000Z';
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(screen.getByRole('tab', { name: 'Trash' }));
      await screen.findByText('Person 1');
      await user.click(checkboxOf('Person 1'));
      await user.click(checkboxOf('Person 2'));
      await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Delete forever' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('Delete 2 responses forever?')).toBeInTheDocument();
      expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
      // Nothing is sent while the question is open.
      expect(callsTo('POST', /bulk$/)).toHaveLength(0);

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(callsTo('POST', /bulk$/)).toHaveLength(0);
      expect(screen.getByText('Person 1')).toBeInTheDocument();
      expect(screen.getByRole('toolbar')).toHaveTextContent('2 responses selected');

      await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Delete forever' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete forever' }));
      await waitFor(() => expect(callsTo('POST', /bulk$/)).toHaveLength(1));
      expect(callsTo('POST', /bulk$/)[0]?.[3]).toEqual({ action: 'delete', ids: [idOf(1), idOf(2)] });
      expect(await screen.findByText('2 responses deleted forever.')).toBeInTheDocument();
      expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
      expect(store.some((row) => row.id === idOf(1))).toBe(false);
    });

    it('says why a delete was refused, keeps the rows and keeps the selection', async () => {
      store[1]!.trashedAt = '2026-11-15T11:00:00.000Z';
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(screen.getByRole('tab', { name: 'Trash' }));
      await screen.findByText('Person 1');
      await user.click(checkboxOf('Person 1'));
      failNext = { match: /POST .*bulk/, error: new ApiProblem(409, 'SUBMISSION_HELD', 'held') };
      await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Delete forever' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete forever' }));
      expect(await screen.findByText('A response under a hold cannot be deleted. Nothing was deleted.')).toBeInTheDocument();
      expect(screen.getByText('Person 1')).toBeInTheDocument();
      expect(screen.getByRole('toolbar')).toHaveTextContent('1 response selected');
    });

    it('says when the member’s role does not allow an action, and changes nothing on the page', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await user.click(checkboxOf('Person 1'));
      failNext = { match: /POST .*bulk/, error: new ApiProblem(403, 'FORBIDDEN', 'Requires submissions.edit.') };
      await user.click(screen.getByRole('button', { name: 'Move to trash' }));
      expect(await screen.findByText('Your role in this organisation does not allow that.')).toBeInTheDocument();
      expect(screen.getByText('Person 1')).toBeInTheDocument();
    });
  });

  describe('the detail pane', () => {
    const openRow = async (user: ReturnType<typeof userEvent.setup>, name: string, index: number) => {
      await user.click(within(rowOf(name)).getByRole('button', { name: new RegExp(`^${formatWhen(makeRow(index).receivedAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }));
    };

    it('opens a response, shows its fields as the server built them, and sends PATCH read=true', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 1');
      expect(rowOf('Person 1')).toHaveAttribute('data-unread', 'true');
      await openRow(user, 'Person 1', 1);

      const pane = await screen.findByRole('complementary', { name: 'Response' });
      expect(await within(pane).findByRole('heading', { name: `Received ${formatWhen(makeRow(1).receivedAt)}` })).toBeInTheDocument();
      expect(within(pane).getByText('Person 1')).toBeInTheDocument();
      expect(within(pane).getByText('Delhi')).toBeInTheDocument();
      expect(callsTo('GET', new RegExp(`/submissions/${idOf(1)}$`))).toHaveLength(1);

      await waitFor(() => expect(callsTo('PATCH', new RegExp(`/submissions/${idOf(1)}$`))).toHaveLength(1));
      expect(callsTo('PATCH', /submissions/)[0]).toEqual(['PATCH', `/v1/forms/${FORM}/submissions/${idOf(1)}`, expect.anything(), { read: true }]);
      // The row in the grid follows without the page being read again.
      await waitFor(() => expect(rowOf('Person 1')).not.toHaveAttribute('data-unread'));
      expect(gridCalls()).toHaveLength(1);
    });

    it('does not send a PATCH to open a response that is read already', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await openRow(user, 'Person 0', 0);
      await within(await screen.findByRole('complementary', { name: 'Response' })).findByText('Delhi');
      expect(callsTo('PATCH', /submissions/)).toHaveLength(0);
    });

    it('shows a protected answer as hidden', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 2');
      await openRow(user, 'Person 2', 2);
      const pane = await screen.findByRole('complementary', { name: 'Response' });
      expect(await within(pane).findByText('••••••')).toBeInTheDocument();
      expect(within(pane).getByRole('img', { name: /protected/ })).toBeInTheDocument();
    });

    it('stars from the pane, and the grid row follows; it can mark the response unread again', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await openRow(user, 'Person 0', 0);
      const pane = await screen.findByRole('complementary', { name: 'Response' });
      await within(pane).findByText('Delhi');

      await user.click(within(pane).getByRole('button', { name: 'Star this response' }));
      await waitFor(() => expect(within(pane).getByRole('button', { name: 'Star this response' })).toHaveAttribute('aria-pressed', 'true'));
      expect(callsTo('PATCH', /submissions/)[0]?.[3]).toEqual({ starred: true });
      expect(within(rowOf('Person 0')).getByRole('button', { name: /^Star response/ })).toHaveAttribute('aria-pressed', 'true');

      await user.click(within(pane).getByRole('button', { name: 'Mark as unread' }));
      await waitFor(() => expect(rowOf('Person 0')).toHaveAttribute('data-unread', 'true'));
      expect(callsTo('PATCH', /submissions/)[1]?.[3]).toEqual({ read: false });
    });

    it('moves to the next and the previous response, and closes', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await openRow(user, 'Person 0', 0);
      const pane = await screen.findByRole('complementary', { name: 'Response' });
      expect(within(pane).getByRole('button', { name: 'Previous response' })).toBeDisabled();
      await user.click(within(pane).getByRole('button', { name: 'Next response' }));
      expect(await within(pane).findByText('Person 1')).toBeInTheDocument();
      expect(within(pane).getByRole('button', { name: 'Previous response' })).toBeEnabled();
      await user.click(within(pane).getByRole('button', { name: 'Close response' }));
      expect(screen.queryByRole('complementary', { name: 'Response' })).not.toBeInTheDocument();
    });

    it('lists the files a response holds: a file is fetched when asked for and saved under the server’s name, a protected one cannot be opened', async () => {
      filesOf[idOf(0)] = [
        { id: '0196f0a0-0000-7000-8000-0000000000f1', blockId: 'b_cv', name: 'cv.pdf', mime: 'application/pdf', sizeBytes: 12_400, purpose: 'file', masked: false },
        { id: null, blockId: 'b_id', name: '••••••', mime: '', sizeBytes: null, purpose: 'file', masked: true },
      ];
      const blob = new Blob(['%PDF'], { type: 'application/pdf' });
      loadSubmissionFile.mockResolvedValue({ blob, name: 'approved-name.pdf', mime: 'application/pdf' });
      URL.createObjectURL = vi.fn(() => 'blob:cv');
      URL.revokeObjectURL = vi.fn();
      const saved: Array<{ href: string; download: string }> = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved.push({ href: this.href, download: this.download });
      });

      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      await openRow(user, 'Person 0', 0);
      const pane = await screen.findByRole('complementary', { name: 'Response' });
      expect(await within(pane).findByText('Protected file: it cannot be opened here.')).toBeInTheDocument();
      // Nothing is fetched until the member asks.
      expect(loadSubmissionFile).not.toHaveBeenCalled();

      await user.click(within(pane).getByRole('button', { name: 'Download cv.pdf' }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(loadSubmissionFile).toHaveBeenCalledWith(FORM, '0196f0a0-0000-7000-8000-0000000000f1');
      // The name is the one the server sent with the file, not the one in the response.
      expect(saved[0]).toEqual({ href: 'blob:cv', download: 'approved-name.pdf' });
    });

    it('says when the response cannot be read, and leaves the grid alone', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      failNext = { match: /GET .*submissions\/0196/, error: new ApiProblem(404, 'NOT_FOUND', 'gone') };
      await openRow(user, 'Person 0', 0);
      expect(await within(await screen.findByRole('complementary', { name: 'Response' })).findByRole('alert')).toHaveTextContent('That form or response is no longer here.');
      expect(screen.getByText('Person 1')).toBeInTheDocument();
    });
  });

  describe('stars in the grid', () => {
    it('stars a response from its row, with one PATCH, and the star shows', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 1');
      await user.click(within(rowOf('Person 1')).getByRole('button', { name: /^Star response/ }));
      await waitFor(() => expect(within(rowOf('Person 1')).getByRole('button', { name: /^Star response/ })).toHaveAttribute('aria-pressed', 'true'));
      expect(callsTo('PATCH', /submissions/)).toEqual([['PATCH', `/v1/forms/${FORM}/submissions/${idOf(1)}`, expect.anything(), { starred: true }]]);
    });
  });

  describe('when something fails', () => {
    it('says the responses could not be loaded and loads them again on Try again', async () => {
      failNext = { match: /GET .*submissions\?/, error: new ApiProblem(500, 'INTERNAL', 'boom') };
      const user = userEvent.setup();
      renderPage();
      expect(await screen.findByText('Responses could not be loaded.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Person 0')).toBeInTheDocument();
    });

    it('stops at a page that did not come, says so, and asks again only when told to (no retry loop)', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Person 0');
      failNext = { match: /GET .*cursor=/, error: new ApiProblem(500, 'INTERNAL', 'boom') };
      await scrollGridTo(30 * ROW_HEIGHT);
      expect(await screen.findByText('More responses could not be loaded.')).toBeInTheDocument();
      await scrollGridTo(31 * ROW_HEIGHT);
      expect(gridCalls()).toHaveLength(2);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(gridCalls()).toHaveLength(3));
      await waitFor(() => expect(screen.queryByText('More responses could not be loaded.')).not.toBeInTheDocument());
    });

    it('starts again from the first page when the API no longer accepts the cursor', async () => {
      renderPage();
      await screen.findByText('Person 0');
      failNext = { match: /GET .*cursor=/, error: new ApiProblem(400, 'INVALID_CURSOR', 'bad') };
      await scrollGridTo(30 * ROW_HEIGHT);
      await waitFor(() => expect(gridCalls()).toHaveLength(3));
      expect(gridCalls()[2]?.has('cursor')).toBe(false);
    });

    it('tells a member whose server is unreachable', async () => {
      const { ApiUnreachable } = await import('@/auth/client');
      failNext = { match: /GET .*submissions\?/, error: new ApiUnreachable() };
      renderPage();
      expect(await screen.findByText('The server cannot be reached. Check your connection and try again.')).toBeInTheDocument();
    });
  });

  it('does not read the preview responses kept in this browser', async () => {
    renderPage();
    await screen.findByText('Person 0');
    expect(screen.queryByText('Rehearsal Person')).not.toBeInTheDocument();
    // Everything on the page came from the API: the grid, and nothing else, was asked for.
    expect(orgApi.mock.calls.every(([method, path]) => method === 'GET' && String(path).startsWith(`/v1/forms/${FORM}/submissions?`))).toBe(true);
  });
});
