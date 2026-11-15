import type { EffectDeps } from '../effects/deps.ts';
import type { AnyJobDefinition, JobDefinition } from './define.ts';
import { exportJobs } from './exports.ts';
import { notificationJobs, notificationsConsumer } from './notifications.ts';
import { createSubmissionFanout } from './submission-fanout.ts';
import { webhookJobs, webhooksConsumer } from './webhooks.ts';

/**
 * The handlers of the "send the answers somewhere" work packages: notifications and emails (WP-1.16), exports (WP-1.17) and
 * webhooks (WP-1.18). They need `EffectDeps` (the mailer, the egress guard, the org's secrets), so they are built here by
 * the composition root and not listed in the static `JOB_DEFINITIONS` next to the jobs that need only a database.
 */
export function createEffectJobs(deps: EffectDeps): AnyJobDefinition[] {
  return [...notificationJobs(deps), ...webhookJobs(deps), ...exportJobs(deps)];
}

/**
 * `submission.fanout` with the consumers of this process: first notifications, then webhooks. It replaces the consumerless
 * `submissionFanout` of `JOB_DEFINITIONS` in `main.ts`; a work package that adds a consumer (integrations, workflows) adds it here.
 */
export function createEffectFanout(deps: EffectDeps): JobDefinition<'submission.fanout'> {
  return createSubmissionFanout([notificationsConsumer(deps), webhooksConsumer(deps)]);
}
