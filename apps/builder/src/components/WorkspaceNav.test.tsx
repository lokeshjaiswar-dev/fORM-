import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore, type Me } from '@/auth/client';
import { WorkspaceNav } from '@/components/WorkspaceNav';
import { ME, fakeReviewApi, problem } from '@/components/review/fakeReviewApi';

function renderNav(at = '/forms') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <WorkspaceNav />
    </MemoryRouter>,
  );
}

const links = () => within(screen.getByRole('navigation', { name: 'Workspace' })).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('WorkspaceNav (WP-2.33)', () => {
  it('shows the Reviews entry, after Forms and Fields, when the active org grants submissions.review', async () => {
    const api = fakeReviewApi({ permissions: ['forms.read', 'submissions.read', 'submissions.review'] });
    renderNav();
    expect(await screen.findByRole('link', { name: 'Reviews' })).toHaveAttribute('href', '/reviews');
    expect(links()).toEqual([
      ['Forms', '/forms'],
      ['Fields', '/fields'],
      ['Reviews', '/reviews'],
    ]);
    // It asks the active org, once.
    expect(api.to('GET', /^\/v1\/org$/)).toHaveLength(1);
    expect(api.to('GET', /^\/v1\/org$/)[0]?.headers['x-fr-org']).toBe('o1');
  });

  it('hides the Reviews entry without submissions.review, whatever else the role grants', async () => {
    const api = fakeReviewApi({ permissions: ['forms.read', 'forms.edit', 'submissions.read', 'submissions.export', 'members.manage'] });
    renderNav();
    await waitFor(() => expect(api.to('GET', /^\/v1\/org$/)).toHaveLength(1));
    // Give the answer time to land before saying the entry is not there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('link', { name: 'Reviews' })).not.toBeInTheDocument();
    expect(links()).toEqual([
      ['Forms', '/forms'],
      ['Fields', '/fields'],
    ]);
  });

  it('hides the entry when the grants cannot be read, instead of guessing', async () => {
    const fetched = vi.fn(() => Promise.resolve(problem(503, 'UNAVAILABLE')));
    vi.stubGlobal('fetch', fetched);
    renderNav();
    await waitFor(() => expect(fetched).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('link', { name: 'Reviews' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forms' })).toBeInTheDocument();
  });

  it('asks for nothing and shows no Reviews entry without an active org', async () => {
    const api = fakeReviewApi();
    const none: Me = { ...ME, orgs: [], activeOrgId: null };
    useSessionStore.setState({ status: 'signed_in', me: none }, true);
    renderNav();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Reviews' })).not.toBeInTheDocument();
  });

  it('marks the tab of the page it is on', async () => {
    fakeReviewApi();
    renderNav('/reviews');
    const reviews = await screen.findByRole('link', { name: 'Reviews' });
    expect(reviews).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Forms' })).not.toHaveAttribute('aria-current');
  });
});
