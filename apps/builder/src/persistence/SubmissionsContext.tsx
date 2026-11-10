import { createContext, useContext, type ReactNode } from 'react';
import { IndexedDbSubmissions } from '@/persistence/IndexedDbSubmissions';
import type { SubmissionsRepository } from '@/persistence/SubmissionsRepository';

const Ctx = createContext<SubmissionsRepository | null>(null);

let browser: SubmissionsRepository | null = null;

export function SubmissionsProvider({ repo, children }: { repo?: SubmissionsRepository; children: ReactNode }) {
  const value = repo ?? (browser ??= new IndexedDbSubmissions());
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSubmissions(): SubmissionsRepository {
  const repo = useContext(Ctx);
  if (!repo) throw new Error('useSubmissions needs a SubmissionsProvider');
  return repo;
}

export function useOptionalSubmissions(): SubmissionsRepository | null {
  return useContext(Ctx);
}
