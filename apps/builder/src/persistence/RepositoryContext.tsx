import type { ReactNode } from 'react';
import type { DocumentRepository } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';
import { RepositoryCtx } from '@/persistence/repository';

let browserRepository: DocumentRepository | null = null;

/** Gives the app its repository: the one passed in, or this browser's IndexedDB. */
export function RepositoryProvider({ repo, children }: { repo?: DocumentRepository; children: ReactNode }) {
  const value = repo ?? (browserRepository ??= new IndexedDbRepository());
  return <RepositoryCtx.Provider value={value}>{children}</RepositoryCtx.Provider>;
}
