import type { EffectDeps } from '../effects/deps.ts';
import type { AnyJobDefinition } from './define.ts';
import type { FanoutConsumer } from './submission-fanout.ts';

/*
 * Webhooks (WP-1.18, INT-01). Foundation stub: the wiring is in place (`createEffectJobs`, `main.ts`), the work arrives
 * with `nx-webhooks-worker`, which fills this file with the `webhook.fanout` and `webhook.deliver` handlers and the consumer
 * that enqueues a fan-out for a complete response when an enabled webhook subscribes.
 */

/** The queues this domain works. */
export function webhookJobs(_deps: EffectDeps): AnyJobDefinition[] {
  return [];
}

/** The `submission.fanout` consumer of this domain; until the work package lands it does nothing. */
export function webhooksConsumer(_deps: EffectDeps): FanoutConsumer {
  return async () => {};
}
