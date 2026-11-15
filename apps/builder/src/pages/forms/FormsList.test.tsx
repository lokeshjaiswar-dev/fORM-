import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useSessionStore, type Me } from '@/auth/client';
import { blankDefinition } from '@/lib/definition';
import { FormsPage } from '@/pages/FormsPage';
import { fakeForm, installFormsApi, type FakeFormsApi } from '@/pages/forms/fakeFormsApi';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import type { StoredForm } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryRepository } from '@/test/fixtures';

/*
 * BL-267: the forms list's controls, one by one, against a stand-in for the forms routes (fakeFormsApi.ts). Each test
 * names what a member does and what the API is asked; the routes themselves are proved in apps/api.
 */

const ORG = 'o1';
const NOW = '2026-11-15T04:30:00.000Z';
const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: ORG, slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: ORG,
};

function Where() {
  const at = useLocation();
  return <span aria-label="path">{at.pathname}</span>;
}

/** The page over a signed-in repository whose cache is `cache`; the server is whatever `fetch` is stubbed as. */
function renderPage(cache = new MemoryRepository()) {
  const repo = new CachingApiRepository(cache, ORG);
  render(
    <RepositoryProvider repo={repo}>
      <MemoryRouter initialEntries={['/forms']}>
        <Routes>
          <Route path="/forms" element={<FormsPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </RepositoryProvider>,
  );
  return { cache, repo, user: userEvent.setup() };
}

/** A form as the browser's cache holds it. */
const cachedForm = (id: string, title: string, patch: Partial<StoredForm> = {}): StoredForm => ({ ...newStoredForm(id, NOW, { ...blankDefinition(id), title }), ...patch });

const rowFor = (title: string) => screen.getByRole('link', { name: new RegExp(`^${title}`) }).closest('li') as HTMLElement;
const lastList = (api: FakeFormsApi) => api.lists().at(-1)?.query;
const WAITS = { timeout: 3000 };

let api: FakeFormsApi;

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
  api = installFormsApi([
    fakeForm('a', { title: 'Alpha', submissionCount: 3, isLive: true, updatedAt: '2026-11-12T04:30:00.000Z', createdAt: '2026-11-01T04:30:00.000Z' }),
    fakeForm('b', { title: 'Beta', updatedAt: '2026-11-11T04:30:00.000Z', createdAt: '2026-11-03T04:30:00.000Z' }),
    fakeForm('c', { title: 'Gamma', lifecycle: 'archived' }),
    fakeForm('d', { title: 'Delta', lifecycle: 'trashed' }),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useSessionStore.setState({ status: 'unknown' }, true);
});

describe('the list', () => {
  it('shows the active forms the server returns, newest first, with its own response count and a Live badge', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: /^Alpha/ })).toHaveAttribute('href', '/builder/a');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]);
    expect(within(rowFor('Alpha')).getByText('Live')).toBeInTheDocument();
    expect(within(rowFor('Alpha')).getByRole('link', { name: 'Responses · 3 responses' })).toHaveAttribute('href', '/forms/a/responses');
    expect(within(rowFor('Beta')).getByRole('link', { name: 'Responses' })).toBeInTheDocument();
    expect(screen.getByText('Showing 2 forms')).toBeInTheDocument();
    const query = lastList(api);
    expect(Object.fromEntries(query ?? [])).toEqual({ limit: '50', lifecycle: 'active', sort: 'updated' });
    expect(api.lists()[0]?.org).toBe(ORG);
  });

  it('says there are no forms when the org has none', async () => {
    api.forms.clear();
    renderPage();
    expect(await screen.findByText('No forms yet. Start a new one.')).toBeInTheDocument();
  });

  it('says so, with a way to try again, when the server answers with a refusal', async () => {
    api.refuse('GET', /^\/v1\/forms$/, 500, 'The forms could not be read.');
    const { user } = renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('The forms could not be read.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /^Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('search', () => {
  it('asks the server for the words typed, once typing pauses, and shows what matches', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search forms' }), 'bet');
    await waitFor(() => expect(lastList(api)?.get('q')).toBe('bet'), WAITS);
    expect(await screen.findByRole('link', { name: /^Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument();
    // One call for the whole word, not one per key.
    expect(api.lists().filter((call) => call.query.has('q'))).toHaveLength(1);
  });

  it('answers a search with no match in words, and clearing it brings the list back', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const box = screen.getByRole('searchbox', { name: 'Search forms' });
    await user.type(box, 'zzz');
    expect(await screen.findByText('No forms match “zzz”.', {}, WAITS)).toBeInTheDocument();
    await user.clear(box);
    expect(await screen.findByRole('link', { name: /^Alpha/ }, WAITS)).toBeInTheDocument();
    expect(lastList(api)?.has('q')).toBe(false);
  });
});

describe('sort', () => {
  it('orders by title and by date created, and starts again from the first page', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const sort = screen.getByRole('combobox', { name: 'Sort by' });
    expect(within(sort).getAllByRole('option').map((o) => o.textContent)).toEqual(['Last updated', 'Date created', 'Title, A to Z']);

    await user.selectOptions(sort, 'title');
    await waitFor(() => expect(lastList(api)?.get('sort')).toBe('title'));
    await waitFor(() => expect(screen.getAllByRole('listitem').map((row) => row.textContent?.slice(0, 4))).toEqual(['Alph', 'Beta']));

    await user.selectOptions(sort, 'created');
    await waitFor(() => expect(lastList(api)?.get('sort')).toBe('created'));
    // Beta was created after Alpha.
    await waitFor(() => expect(screen.getAllByRole('listitem').map((row) => row.textContent?.slice(0, 4))).toEqual(['Beta', 'Alph']));
    expect(lastList(api)?.has('cursor')).toBe(false);
  });
});

describe('stars', () => {
  it('stars and unstars a form: shown at once, sent with the session headers, and kept for the starred filter', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const star = screen.getByRole('button', { name: 'Star Alpha' });
    expect(star).toHaveAttribute('aria-pressed', 'false');

    await user.click(star);
    expect(screen.getByRole('button', { name: 'Star Alpha' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(api.forms.get('a')?.favourite).toBe(true));
    const put = api.calls.find((call) => call.method === 'PUT');
    expect(put).toMatchObject({ path: '/v1/forms/a/favourite', org: ORG, csrf: 'builder' });

    await user.click(screen.getByRole('button', { name: 'Star Alpha' }));
    await waitFor(() => expect(api.forms.get('a')?.favourite).toBe(false));
    expect(screen.getByRole('button', { name: 'Star Alpha' })).toHaveAttribute('aria-pressed', 'false');
    expect(api.calls.some((call) => call.method === 'DELETE' && call.path === '/v1/forms/a/favourite')).toBe(true);
  });

  it('puts the star back and says so when the server does not take it', async () => {
    api.refuse('PUT', /favourite$/, 500, 'The star could not be saved.');
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Star Alpha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The star could not be saved.');
    expect(screen.getByRole('button', { name: 'Star Alpha' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows only starred forms when asked, and an unstarred form leaves that view', async () => {
    api.forms.get('b')!.favourite = true;
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const only = screen.getByRole('button', { name: 'Starred only' });
    expect(only).toHaveAttribute('aria-pressed', 'false');
    await user.click(only);
    await waitFor(() => expect(lastList(api)?.get('favourite')).toBe('true'));
    expect(await screen.findByRole('link', { name: /^Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starred only' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Star Beta' }));
    expect(await screen.findByText('No starred forms yet. Star a form to find it here quickly.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Starred only' }));
    await waitFor(() => expect(lastList(api)?.has('favourite')).toBe(false));
    expect(await screen.findByRole('link', { name: /^Alpha/ })).toBeInTheDocument();
  });
});

describe('folders', () => {
  it('has Active, Archived and Trash as tabs; the arrow keys, Home and End move between them', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Active', 'Archived', 'Trash']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    // One stop in the tab order; the panel it controls exists.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', tabs[0]?.getAttribute('aria-controls'));

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveFocus();
    await waitFor(() => expect(lastList(api)?.get('lifecycle')).toBe('archived'));
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Trash' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Trash' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  });

  it('lists archived forms, and Move back to Active returns one to the Active list', async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Archived' }));
    expect(await screen.findByRole('link', { name: /^Gamma/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument();
    expect(lastList(api)?.get('lifecycle')).toBe('archived');

    await user.click(screen.getByRole('button', { name: 'Actions for Gamma' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Move back to Active' }));
    expect(await screen.findByText('No archived forms. Archive a form to take it off your list without deleting it.')).toBeInTheDocument();
    expect(api.forms.get('c')?.lifecycle).toBe('active');
    expect(screen.getByRole('status')).toHaveTextContent('“Gamma” is active again.');
    expect(within(screen.getByRole('status')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/builder/c');
  });

  it('the Trash tab says what the trash is, lists trashed forms without a link to open them, and Restore brings one back', async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Trash' }));
    expect(await screen.findByText('Delta')).toBeInTheDocument();
    expect(screen.getByText('Forms in the trash can be restored. Nothing is deleted for good yet.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Delta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore Delta' }));
    expect(await screen.findByText('The trash is empty. Forms in the trash can be restored, and nothing is deleted for good.')).toBeInTheDocument();
    expect(api.forms.get('d')?.lifecycle).toBe('active');
    expect(screen.getByRole('status')).toHaveTextContent('“Delta” was restored.');

    await user.click(screen.getByRole('tab', { name: 'Active' }));
    expect(await screen.findByRole('link', { name: /^Delta/ })).toBeInTheDocument();
  });

  it('an empty trash says that forms in it can be restored and that nothing is deleted for good', async () => {
    api.forms.get('d')!.lifecycle = 'active';
    const { user } = renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Trash' }));
    expect(await screen.findByText(/Forms in the trash can be restored/)).toHaveTextContent('nothing is deleted for good');
  });
});

describe('archive, trash, clone', () => {
  it('archives a form from its menu, tells the member, and Undo restores it', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument());
    expect(api.forms.get('a')?.lifecycle).toBe('archived');
    expect(screen.getByRole('status')).toHaveTextContent('“Alpha” was archived.');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('link', { name: /^Alpha/ })).toBeInTheDocument();
    expect(api.forms.get('a')?.lifecycle).toBe('active');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('moves a form to the server trash (and out of this browser), and Undo brings it back', async () => {
    const cache = new MemoryRepository();
    await cache.save({ ...newStoredForm('a', NOW), serverRev: 2, dirty: false });
    const { user } = renderPage(cache);
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to trash' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument());
    expect(api.forms.get('a')?.lifecycle).toBe('trashed');
    expect(cache.records.has('a')).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('“Alpha” was moved to the trash.');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('link', { name: /^Alpha/ })).toBeInTheDocument();
    expect(api.forms.get('a')?.lifecycle).toBe('active');
  });

  it('a form in the Archived folder can go to the trash too', async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Archived' }));
    await screen.findByRole('link', { name: /^Gamma/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Gamma' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to trash' }));
    await waitFor(() => expect(api.forms.get('c')?.lifecycle).toBe('trashed'));
  });

  it('makes a copy: the API names it, the list shows it, and the notice opens it', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Make a copy' }));
    expect(await screen.findByRole('link', { name: /^Copy of Alpha/ })).toHaveAttribute('href', '/builder/copy-1');
    expect(screen.getByRole('status')).toHaveTextContent('“Copy of Alpha” was created.');
    expect(within(screen.getByRole('status')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/builder/copy-1');
    expect(api.calls.find((call) => call.path === '/v1/forms/a/clone')).toMatchObject({ method: 'POST', csrf: 'builder', org: ORG });
  });

  it('says a member without permission may not, and leaves the form where it is', async () => {
    api.refuse('POST', /archive$/, 403, 'Only editors can change a form.');
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only editors can change a form.');
    expect(screen.getByRole('link', { name: /^Alpha/ })).toBeInTheDocument();
    expect(api.forms.get('a')?.lifecycle).toBe('active');
  });

  it('a refusal for want of permission that names no reason still says that much', async () => {
    api.refuse('POST', /archive$/, 403);
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
  });

  it('turns a row off while its call is out, so a second click cannot send it twice', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    const wait = api.hold();
    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(screen.getByRole('button', { name: 'Actions for Alpha' })).toBeDisabled();
    wait.release();
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument());
    expect(api.calls.filter((call) => call.path === '/v1/forms/a/archive')).toHaveLength(1);
  });
});

describe('paging', () => {
  it('loads the next page with the server cursor, and stops offering more at the end', async () => {
    api.forms.clear();
    for (let i = 0; i < 60; i += 1) {
      api.forms.set(`f${i}`, fakeForm(`f${i}`, { title: `Form ${String(i).padStart(2, '0')}`, updatedAt: `2026-11-10T04:${String(59 - i).padStart(2, '0')}:00.000Z` }));
    }
    const { user } = renderPage();
    await screen.findByText('Showing the first 50 forms');
    expect(screen.getAllByRole('listitem')).toHaveLength(50);

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 60 forms')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    const second = api.lists()[1]?.query;
    expect(second?.get('cursor')).toBeTruthy();
    expect(second?.get('lifecycle')).toBe('active');
  });

  it('keeps what is shown and says so when the next page fails; Load more tries again', async () => {
    api.forms.clear();
    for (let i = 0; i < 60; i += 1) api.forms.set(`f${i}`, fakeForm(`f${i}`, { title: `Form ${String(i).padStart(2, '0')}` }));
    const { user } = renderPage();
    await screen.findByText('Showing the first 50 forms');
    api.refuse('GET', /^\/v1\/forms$/, 503, 'The next forms could not be read.');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The next forms could not be read.');
    expect(screen.getAllByRole('listitem')).toHaveLength(50);

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 60 forms')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a cursor belongs to its query: changing the search starts again at the first page, with no cursor', async () => {
    api.forms.clear();
    for (let i = 0; i < 60; i += 1) api.forms.set(`f${i}`, fakeForm(`f${i}`, { title: `Form ${String(i).padStart(2, '0')}` }));
    const { user } = renderPage();
    await screen.findByText('Showing the first 50 forms');
    await user.type(screen.getByRole('searchbox', { name: 'Search forms' }), '5');
    await waitFor(() => expect(lastList(api)?.get('q')).toBe('5'), WAITS);
    expect(lastList(api)?.has('cursor')).toBe(false);
    expect(await screen.findByText('Showing 15 forms')).toBeInTheDocument();
  });
});

describe('when the server cannot be reached', () => {
  const offline = () => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

  it('falls back to the forms saved in this browser, with search, and says what needs the server', async () => {
    const cache = new MemoryRepository();
    await cache.save(cachedForm('l1', 'Offline one', { serverRev: 2 }));
    await cache.save(cachedForm('l2', 'Another', { serverRev: 2 }));
    offline();
    const { user } = renderPage(cache);
    expect(await screen.findByRole('link', { name: /^Offline one/ })).toBeInTheDocument();
    expect(screen.getByText(/The server cannot be reached, so this is the list saved in this browser/)).toBeInTheDocument();
    // What only the server can do is off, not hidden: sort and the starred filter are disabled, and rows have no star.
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starred only' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Star / })).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search forms' }), 'anoth');
    // Both were listed; once the search has been applied only the match is.
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Offline one/ })).not.toBeInTheDocument(), WAITS);
    expect(await screen.findByRole('link', { name: /^Another/ }, WAITS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Offline one/ })).not.toBeInTheDocument();
  });

  it('the Archived and Trash folders say they are on the server', async () => {
    offline();
    const { user } = renderPage();
    await user.click(await screen.findByRole('tab', { name: 'Trash' }));
    expect(await screen.findByText('Archived forms and the trash are kept on the server, which cannot be reached right now.')).toBeInTheDocument();
  });
});

describe('forms only this browser has', () => {
  const withLocalOnly = async () => {
    const cache = new MemoryRepository();
    await cache.save(cachedForm('local-1', 'Made offline', { serverRev: 0, dirty: true }));
    // A form the server knows is not listed twice, and one it knows is not "unsynced".
    await cache.save({ ...newStoredForm('a', NOW), serverRev: 2, dirty: false });
    return cache;
  };

  it('are listed first and marked, because they are in no server page', async () => {
    renderPage(await withLocalOnly());
    expect(await screen.findByRole('link', { name: /^Made offline/ })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Made offline');
    expect(within(items[0]!).getByText('Not saved to the server yet')).toBeInTheDocument();
    expect(items).toHaveLength(3);
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
  });

  it('can only be deleted, after asking, because nothing can bring them back', async () => {
    const cache = await withLocalOnly();
    const { user } = renderPage(cache);
    await screen.findByRole('link', { name: /^Made offline/ });
    expect(screen.queryByRole('button', { name: 'Star Made offline' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for Made offline' }));
    expect(screen.queryByRole('menuitem', { name: 'Make a copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Delete form' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('“Made offline” was never saved to the server, so it cannot be restored.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(cache.records.has('local-1')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Actions for Made offline' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete form' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete form' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Made offline/ })).not.toBeInTheDocument());
    expect(cache.records.has('local-1')).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('“Made offline” was deleted.');
    expect(within(screen.getByRole('status')).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('are not mixed into the Archived folder or the starred view', async () => {
    const { user } = renderPage(await withLocalOnly());
    await screen.findByRole('link', { name: /^Made offline/ });
    await user.click(screen.getByRole('button', { name: 'Starred only' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Made offline/ })).not.toBeInTheDocument());
  });
});

describe('merge', () => {
  it('is offered for two or more forms, and the selection is dropped when the list changes', async () => {
    const { user } = renderPage();
    await screen.findByRole('link', { name: /^Alpha/ });
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    expect(screen.getByRole('button', { name: 'Merge selected' })).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: 'Archived' }));
    await screen.findByRole('link', { name: /^Gamma/ });
    // Archived has one form: nothing to merge; and going back finds nothing selected.
    expect(screen.queryByRole('button', { name: 'Merge selected' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Active' }));
    await screen.findByRole('link', { name: /^Alpha/ });
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Merge selected' })).toBeDisabled();
  });
});
