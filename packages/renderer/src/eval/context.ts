import { createContext, useContext, useMemo } from 'react';
import type { EvalMeta, RuntimeFormVersion } from '@form/schema';
import { EvalSession, type Evaluation } from './session.ts';

export const EvalContext = createContext<Evaluation | null>(null);

export function useEvaluation(): Evaluation {
  const evaluation = useContext(EvalContext);
  if (!evaluation) throw new Error('useEvaluation() outside <EvalProvider>');
  return evaluation;
}

/** One evaluator per version and session meta. */
export const useEvalSession = (version: RuntimeFormVersion, meta: EvalMeta): EvalSession => useMemo(() => new EvalSession(version, meta), [version, meta]);
