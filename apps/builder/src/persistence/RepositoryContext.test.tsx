import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useSessionStore, type Me } from '@/auth/client';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { MemoryRepository } from '@/test/fixtures';

/*
 * BL-273: the provider is what sees the session become signed in, wherever the member signed in (password, second
 * factor, emailed link, OAuth) or whether they were signed in already when the page loaded.
 */

const clearOnce = vi.fn(() => Promise.resolve('deleted' as const));
vi.mock('@/persistence/legacyBuilderDb', () => ({ clearLegacyBuilderDbOnce: () => clearOnce() }));

const ME: Me = {
  user: { id: 'u1', email: 'asha@example.test', name: null, emailVerified: true, totpEnabled: false },
  session: null,
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' }],
  activeOrgId: 'o1',
};

beforeEach(() => {
  clearOnce.mockClear();
  useSessionStore.setState({ status: 'signed_out' }, true);
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
});

describe('RepositoryProvider and the old signed-out database (BL-273)', () => {
  it('does not touch it while nobody is signed in', () => {
    render(<RepositoryProvider repo={new MemoryRepository()}>x</RepositoryProvider>);
    expect(clearOnce).not.toHaveBeenCalled();
  });

  it('deletes it when the session becomes signed in', () => {
    render(<RepositoryProvider repo={new MemoryRepository()}>x</RepositoryProvider>);
    act(() => useSessionStore.setState({ status: 'signed_in', me: ME }, true));
    expect(clearOnce).toHaveBeenCalledTimes(1);
  });

  it('deletes it for a member who was already signed in when the page loaded', () => {
    useSessionStore.setState({ status: 'signed_in', me: ME }, true);
    render(<RepositoryProvider repo={new MemoryRepository()}>x</RepositoryProvider>);
    expect(clearOnce).toHaveBeenCalledTimes(1);
  });

  it('a member who has no organisation yet is signed in too', () => {
    useSessionStore.setState({ status: 'signed_in', me: { ...ME, orgs: [], activeOrgId: null } }, true);
    render(<RepositoryProvider repo={new MemoryRepository()}>x</RepositoryProvider>);
    expect(clearOnce).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when the member switches organisation', () => {
    useSessionStore.setState({ status: 'signed_in', me: ME }, true);
    render(<RepositoryProvider repo={new MemoryRepository()}>x</RepositoryProvider>);
    act(() => useSessionStore.setState({ status: 'signed_in', me: { ...ME, orgs: [...ME.orgs, { id: 'o2', slug: 'b', name: 'B', role: 'owner' }], activeOrgId: 'o2' } }, true));
    expect(clearOnce).toHaveBeenCalledTimes(1);
  });
});
