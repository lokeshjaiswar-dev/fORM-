import { patternProblem } from '@form/validation';

/** The inspector's note on a v1 pattern: re2js (@form/validation) is the engine the renderer and the server use (B12, VAL-04). */
export function patternError(pattern?: string) {
  if (!pattern) return null;
  const problem = patternProblem({ source: pattern });
  return problem ? `Invalid pattern; it is ignored until fixed (${problem})` : null;
}
