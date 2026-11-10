import type { ReactNode } from 'react';
import { CachingApiRepository } from '@/persistence/CachingApiRepository';
import type { DocumentRepository } from '@/persistence/DocumentRepository';
import { IndexedDbRepository } from '@/persistence/IndexedDbRepository';
import { RepositoryCtx } from '@/persistence/repository';

let browserRepository: DocumentRepository | null = null;

/** Gives the app its repository: the one passed in, or IndexedDB plus the API when signed in. */
export function RepositoryProvider({ repo, children }: { repo?: DocumentRepository; children: ReactNode }) {
  const value = repo ?? (browserRepository ??= new CachingApiRepository(new IndexedDbRepository()));
  return <RepositoryCtx.Provider value={value}>{children}</RepositoryCtx.Provider>;
}
