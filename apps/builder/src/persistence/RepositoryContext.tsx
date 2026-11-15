import { useEffect, type ReactNode } from 'react';
import { activeOrgOf, useSessionStore } from '@/auth/client';
import type { DocumentRepository } from '@/persistence/DocumentRepository';
import { clearLegacyBuilderDbOnce } from '@/persistence/legacyBuilderDb';
import { RepositoryCtx, repositoryFor } from '@/persistence/repository';

/**
 * Nobody is signed in, so there is nothing to read or save: the builder's pages sit behind the session gate (BL-206)
 * and never reach this. It exists so `useRepository` never throws while the session is still being asked for.
 */
const NO_SESSION: DocumentRepository = {
  list: () => Promise.resolve([]),
  load: () => Promise.resolve(null),
  save: () => Promise.reject(new Error('Sign in to save forms.')),
  remove: () => Promise.reject(new Error('Sign in to remove forms.')),
};

/**
 * Gives the app its repository: the one passed in (tests), or the signed-in member's active org (WP-1.06). Switching
 * the active org gives every page a different repository, so a page reloads its forms instead of showing the last org's.
 *
 * The first time someone is signed in, the old signed-out builder's IndexedDB database is deleted (BL-273): it may hold
 * form passwords in plain text, and nothing reads it any more.
 */
export function RepositoryProvider({ repo, children }: { repo?: DocumentRepository; children: ReactNode }) {
  const orgId = useSessionStore((s) => (s.status === 'signed_in' ? (activeOrgOf(s.me)?.id ?? null) : null));
  const signedIn = useSessionStore((s) => s.status === 'signed_in');
  const value = repo ?? (orgId ? repositoryFor(orgId) : NO_SESSION);
  useEffect(() => {
    if (signedIn) void clearLegacyBuilderDbOnce();
  }, [signedIn]);
  return <RepositoryCtx.Provider value={value}>{children}</RepositoryCtx.Provider>;
}
