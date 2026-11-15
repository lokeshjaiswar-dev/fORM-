import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes } from '@/App';
import { useSessionStore, type Me } from '@/auth/client';
import { DOCUMENT_FORMAT, LEGACY_FORMAT } from '@/persistence/DocumentRepository';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { newStoredForm } from '@/persistence/openForm';
import { MemoryCustomFieldRepository, setCustomFieldRepository } from '@/fields/custom/repository';
import { MemoryRepository, MemorySubmissions, block, formWith, v1Form } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00.000Z';

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};
const signedIn = () => useSessionStore.setState({ status: 'signed_in', me: ME }, true);

function Where() {
  return <span aria-label="path">{useLocation().pathname}</span>;
}

function renderApp(repo: MemoryRepository, path: string, submissions = new MemorySubmissions()) {
  return render(
    <RepositoryProvider repo={repo}>
      <SubmissionsProvider repo={submissions}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <Where />
        </MemoryRouter>
      </SubmissionsProvider>
    </RepositoryProvider>,
  );
}

const path = () => screen.getByLabelText('path').textContent;

/** Opening the builder renders the whole canvas and editors; under parallel load that takes longer than findBy's 1 s default. */
const OPENS = { timeout: 15_000 };

function stored(id: string, title: string) {
  return newStoredForm(id, NOW, { ...formWith([block('short_text', 'q', { label: 'Question' })]), title });
}

describe('routes', () => {
  beforeEach(() => {
    setCustomFieldRepository(new MemoryCustomFieldRepository());
    signedIn();
  });

  afterEach(() => {
    useSessionStore.setState({ status: 'unknown' }, true);
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  describe('the session gate (BL-206)', () => {
    /** An API that answers `/v1/me` with 401 and everything else with nothing the page can use. */
    const stubSignedOutApi = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
          Promise.resolve(
            String(url).endsWith('/v1/me')
              ? new Response(JSON.stringify({ code: 'UNAUTHENTICATED', title: 'Sign in' }), { status: 401, headers: { 'content-type': 'application/problem+json' } })
              : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
          ),
        ),
      );

    it('/forms redirects a signed-out visitor to /auth/sign-in, and remembers the page to come back to', async () => {
      useSessionStore.setState({ status: 'signed_out' }, true);
      renderApp(new MemoryRepository(), '/forms');
      expect(await screen.findByRole('heading', { name: 'Sign in' }, OPENS)).toBeInTheDocument();
      expect(path()).toBe('/auth/sign-in');
      expect(sessionStorage.getItem('fr.afterSignIn')).toBe('/forms');
      expect(screen.queryByText(/No forms yet/)).not.toBeInTheDocument();
    });

    it('/builder/:id is gated the same way, and never opens the form for a signed-out visitor', async () => {
      useSessionStore.setState({ status: 'signed_out' }, true);
      const repo = new MemoryRepository();
      await repo.save(stored('f1', 'Feedback'));
      renderApp(repo, '/builder/f1/preview');
      expect(await screen.findByRole('heading', { name: 'Sign in' }, OPENS)).toBeInTheDocument();
      expect(path()).toBe('/auth/sign-in');
      expect(sessionStorage.getItem('fr.afterSignIn')).toBe('/builder/f1/preview');
      expect(screen.queryByDisplayValue('Feedback')).not.toBeInTheDocument();
    });

    it('a visitor whose session is not known yet is asked for once (/v1/me); a 401 sends them to sign in', async () => {
      stubSignedOutApi();
      useSessionStore.setState({ status: 'unknown' }, true);
      renderApp(new MemoryRepository(), '/forms');
      expect(await screen.findByRole('heading', { name: 'Sign in' }, OPENS)).toBeInTheDocument();
      expect(path()).toBe('/auth/sign-in');
      const asked = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/v1/me'));
      expect(asked).toHaveLength(1);
    });

    it('/f/:slug stays open to a signed-out visitor: no redirect, no session lookup', async () => {
      stubSignedOutApi();
      useSessionStore.setState({ status: 'signed_out' }, true);
      renderApp(new MemoryRepository(), '/f/hello');
      expect(await screen.findByRole('heading', { name: 'Form not found' }, OPENS)).toBeInTheDocument();
      expect(path()).toBe('/f/hello');
      expect(sessionStorage.getItem('fr.afterSignIn')).toBeNull();
    });

    it('says so, with a retry, when the server cannot be reached; it does not send anyone to sign in', async () => {
      useSessionStore.setState({ status: 'unreachable' }, true);
      renderApp(new MemoryRepository(), '/forms');
      expect(await screen.findByRole('heading', { name: 'The server cannot be reached' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(path()).toBe('/forms');
    });

    it('a member of no org is asked to create one instead of being shown a forms list that cannot be saved', async () => {
      useSessionStore.setState({ status: 'signed_in', me: { ...ME, orgs: [], activeOrgId: null } }, true);
      renderApp(new MemoryRepository(), '/forms');
      expect(await screen.findByRole('heading', { name: 'Create an organisation to start' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Set up your organisation' })).toHaveAttribute('href', '/orgs/new');
      // The account menu stays, so there is still a way to the account pages and to sign out.
      expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument();
      expect(screen.queryByText(/No forms yet/)).not.toBeInTheDocument();
    });
  });

  it('keeps /f/:slug as the public fill page', async () => {
    renderApp(new MemoryRepository(), '/f/hello');
    expect(await screen.findByText(/Form not found|This form cannot be opened|This link is not a published form/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/f/hello');
  });

  it('sends / to the forms list', async () => {
    renderApp(new MemoryRepository(), '/');
    expect(await screen.findByText(/No forms yet/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/forms');
  });

  it('sends /fields to the forms list', async () => {
    renderApp(new MemoryRepository(), '/fields');
    expect(await screen.findByText(/No forms yet/, {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/forms');
  });

  it('New form → Blank opens an empty v2 form at its own id (B23)', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/, {}, OPENS);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /Blank form/ }, OPENS));
    expect(await screen.findByRole('button', { name: 'Press Enter to start from scratch' }, OPENS)).toBeInTheDocument();
    const id = path()?.replace('/builder/', '') ?? '';
    expect(id).not.toBe('demo');
    expect(repo.records.get(id)).toMatchObject({ id, rev: 0, format: DOCUMENT_FORMAT, doc: { formId: id, schemaVersion: 2, blocks: {} } });
  });

  it('New form → a template instantiates it offline as a new v2 form', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Contact us/ }, OPENS));
    fireEvent.click(screen.getByRole('button', { name: 'Use template' }));
    expect(await screen.findByDisplayValue('Contact us', {}, OPENS)).toBeInTheDocument();
    const id = path()?.replace('/builder/', '') ?? '';
    const record = repo.records.get(id);
    expect(record).toMatchObject({ format: DOCUMENT_FORMAT, doc: { formId: id, title: 'Contact us' } });
    expect(Object.keys((record?.doc as { blocks?: object } | undefined)?.blocks ?? {}).length).toBeGreaterThan(3);
  });

  it('opens responses for a form and shows the responses the API holds for it, not the preview ones kept in this browser', async () => {
    const repo = new MemoryRepository();
    const submissions = new MemorySubmissions();
    await repo.save(stored('f1', 'Feedback'));
    await submissions.create({
      id: 'local1',
      formId: 'f1',
      submittedAt: NOW,
      answers: { q: { type: 'short_text', value: 'Rehearsal answer' } },
      fields: [{ key: 'q', label: 'Question', value: 'Rehearsal answer' }],
    });
    const grid = {
      columns: [{ id: 'q', key: 'q', label: 'Question', type: 'short_text' }],
      items: [{ id: 's1', receivedAt: NOW, status: 'complete', read: false, starred: false, archivedAt: null, trashedAt: null, versionNumber: 1, cells: { q: 'Hello' }, masked: [] }],
      nextCursor: null,
    };
    const answer = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(grid), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', answer);
    // jsdom has no layout, and a list with no height shows no rows: give the grid a screen.
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(440);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    renderApp(repo, '/forms', submissions);
    fireEvent.click(await screen.findByRole('link', { name: /Responses/ }));
    expect(path()).toBe('/forms/f1/responses');
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Question' })).toBeInTheDocument();
    expect(screen.queryByText('Rehearsal answer')).not.toBeInTheDocument();
    expect(answer.mock.calls[0]?.[0]).toContain('/v1/forms/f1/submissions?');
  });

  it('deletes a form from the list', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/forms');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete form' }));
    expect(await screen.findByText(/No forms yet/)).toBeInTheDocument();
    expect(repo.records.has('f1')).toBe(false);
  });

  it('lists saved forms and opens one', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/forms');
    fireEvent.click(await screen.findByRole('link', { name: /Feedback/ }));
    expect(await screen.findByDisplayValue('Feedback', {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/builder/f1');
  });

  it('reopening a form restores what was saved (reload)', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Before'));
    const first = renderApp(repo, '/builder/f1');
    const title = await screen.findByDisplayValue('Before', {}, OPENS);
    const user = userEvent.setup();
    await user.clear(title);
    await user.type(title, 'After');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    first.unmount();
    expect(repo.records.get('f1')).toMatchObject({ rev: expect.any(Number), doc: { title: 'After' } });

    renderApp(repo, '/builder/f1');
    expect(await screen.findByDisplayValue('After', {}, OPENS)).toBeInTheDocument();
  });

  it('the preview URL opens the preview, and Edit returns to the canvas', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('f1', 'Feedback'));
    renderApp(repo, '/builder/f1/preview');
    expect(await screen.findByRole('button', { name: 'Submit' }, OPENS)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Feedback')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Feedback', {}, OPENS)).toBeInTheDocument();
    expect(path()).toBe('/builder/f1');
  });

  it('says so when the form does not exist or cannot be read', async () => {
    const repo = new MemoryRepository();
    renderApp(repo, '/builder/nope');
    expect(await screen.findByRole('heading', { name: 'Form not found' })).toBeInTheDocument();

    await repo.save({ id: 'odd', format: 'v9', rev: 1, savedAt: NOW, doc: {} });
    renderApp(repo, '/builder/odd');
    expect(await screen.findByRole('heading', { name: 'This form cannot be opened' })).toBeInTheDocument();
  });

  it('says so when this browser cannot save a new form', async () => {
    const repo = new MemoryRepository();
    vi.spyOn(repo, 'save').mockRejectedValue(new Error('QuotaExceededError'));
    renderApp(repo, '/forms');
    await screen.findByText(/No forms yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.click(await screen.findByRole('button', { name: /Blank form/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved in this browser');
    expect(path()).toBe('/forms');
  });

  it('merges two selected forms from the list', async () => {
    const repo = new MemoryRepository();
    await repo.save(stored('one', 'Alpha'));
    await repo.save(stored('two', 'Beta'));
    renderApp(repo, '/forms');
    expect(await screen.findByText('Alpha', {}, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));
    expect(await screen.findByDisplayValue('Alpha + Beta', {}, OPENS)).toBeInTheDocument();
    expect(path()?.startsWith('/builder/')).toBe(true);
  });

  it('asks which field to keep when merged validations clash', async () => {
    const repo = new MemoryRepository();
    await repo.save(newStoredForm('one', NOW, formWith([block('short_text', 'n1', { label: 'Code', config: { pattern: { source: '^[A-Z]+$' } } })])));
    await repo.save(newStoredForm('two', NOW, formWith([block('short_text', 'n2', { label: 'Code', config: { pattern: { source: '^[0-9]+$' } } })])));
    renderApp(repo, '/forms');
    expect(await screen.findAllByText('Test form', {}, OPENS)).toHaveLength(2);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));
    expect(await screen.findByRole('heading', { name: 'These fields cannot be combined' }, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Merge with these choices' }));
    expect(await screen.findByDisplayValue(/Test form/, {}, OPENS)).toBeInTheDocument();
  });

  it('BL-143: reopening a v1 draft migrates it once, saves it back as v2 and shows what changed', async () => {
    const repo = new MemoryRepository();
    await repo.save({ id: 'old', format: LEGACY_FORMAT, rev: 2, savedAt: NOW, doc: v1Form([{ id: 'q', type: 'text', label: 'Question' }], { redirectUrl: 'http://example.com', password: 'hunter2' }) });
    // The v1 file's password goes to the API (WP-1.07, BL-145): the form row, then the access settings, then the password.
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = String(url);
        if (!path.startsWith('/v1/forms')) return Promise.resolve(json(404, {}));
        sent.push({ method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (path === '/v1/forms') return Promise.resolve(json(201, { id: 'old' }));
        if (path === '/v1/forms/old/access') return Promise.resolve(json(200, { rev: 0, enabled: true, hasPassword: false, embedAllowlist: [], screens: {}, acceptPreviousVersionsHours: 72 }));
        return Promise.resolve(json(200, { hasPassword: true }));
      }),
    );
    renderApp(repo, '/builder/old');
    expect(await screen.findByDisplayValue('Old form', {}, OPENS)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('region', { name: 'Form notes' })).toHaveTextContent('the redirect URL is not https');
    expect(screen.getByRole('region', { name: 'Form notes' })).toHaveTextContent('are now settings on the server');
    expect(sent.find((c) => c.method === 'PUT' && c.path === '/v1/forms/old/access/password')?.body).toEqual({ password: 'hunter2' });
    expect(repo.records.get('old')).toMatchObject({ format: DOCUMENT_FORMAT, rev: 3, doc: { formId: 'old', schemaVersion: 2 }, ops: {} });
    // The plaintext password is in neither the saved draft nor the saved local settings (BL-145).
    expect(JSON.stringify(repo.records.get('old'))).not.toContain('hunter2');
  });
});
