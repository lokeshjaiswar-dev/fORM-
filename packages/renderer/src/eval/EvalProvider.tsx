import type { ReactNode } from 'react';
import { useWatch, type Control, type FieldValues } from 'react-hook-form';
import type { RawAnswers } from '@form/validation/lazy';
import { EvalContext } from './context.ts';
import type { EvalSession } from './session.ts';

/** Re-evaluates on every watched answer change (`useWatch`) and gives the result to the blocks below. */
export function EvalProvider({ session, control, children }: { session: EvalSession; control: Control<FieldValues>; children: ReactNode }) {
  const raw = useWatch({ control }) as RawAnswers;
  return <EvalContext.Provider value={session.evaluate(raw)}>{children}</EvalContext.Provider>;
}
