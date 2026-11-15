import type { EffectDeps } from '../effects/deps.ts';
import type { AnyJobDefinition } from './define.ts';
import type { FanoutConsumer } from './submission-fanout.ts';

/*
 * Notifications (WP-1.16, NOT-01..05). Foundation stub: the wiring is in place (`createEffectJobs`, `main.ts`), the work
 * arrives with `nx-notify-worker`, which fills this file with the `notification.dispatch` and `email.send` handlers and the
 * consumer that enqueues a dispatch per enabled notification of a complete response.
 */

/** The queues this domain works. */
export function notificationJobs(_deps: EffectDeps): AnyJobDefinition[] {
  return [];
}

/** The `submission.fanout` consumer of this domain; until the work package lands it does nothing. */
export function notificationsConsumer(_deps: EffectDeps): FanoutConsumer {
  return async () => {};
}
