import type { EffectDeps } from '../effects/deps.ts';
import type { AnyJobDefinition } from './define.ts';

/*
 * Exports (WP-1.17, EXP-01). Foundation stub: the wiring is in place (`createEffectJobs`, `main.ts`), the work arrives with
 * `nx-exports-worker`, which fills this file with the `export.build` handler. An export is asked for by a person, not
 * triggered by a response, so this domain has no `submission.fanout` consumer.
 */

/** The queues this domain works. */
export function exportJobs(_deps: EffectDeps): AnyJobDefinition[] {
  return [];
}
