import { createContext, useContext } from 'react';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import type { DocumentRepository } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';

export const RepositoryCtx = createContext<DocumentRepository | null>(null);

export function useRepository(): DocumentRepository {
  const repo = useContext(RepositoryCtx);
  if (!repo) throw new Error('useRepository needs a RepositoryProvider');
  return repo;
}

/** The offline cache of one org: its own IndexedDB database, so forms of two orgs never meet in this browser (BL-231). */
export const cacheDbName = (orgId: string): string => `fORM-builder:${orgId}`;

const byOrg = new Map<string, DocumentRepository>();

/** The signed-in repository of `orgId` (the server's drafts over that org's cache); one per org in this page. */
export function repositoryFor(orgId: string): DocumentRepository {
  let repo = byOrg.get(orgId);
  if (!repo) {
    repo = new CachingApiRepository(new IndexedDbRepository(cacheDbName(orgId)), orgId);
    byOrg.set(orgId, repo);
  }
  return repo;
}
