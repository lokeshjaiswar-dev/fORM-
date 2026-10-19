import { createContext, useContext } from 'react';
import type { DocumentRepository } from '@/persistence/DocumentRepository';

export const RepositoryCtx = createContext<DocumentRepository | null>(null);

export function useRepository(): DocumentRepository {
  const repo = useContext(RepositoryCtx);
  if (!repo) throw new Error('useRepository needs a RepositoryProvider');
  return repo;
}
