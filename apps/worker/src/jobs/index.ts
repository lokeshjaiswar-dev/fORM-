import { auditChain } from './audit-chain.ts';
import type { AnyJobDefinition } from './define.ts';
import { heartbeat } from './heartbeat.ts';
import { partitionsMaintain } from './partitions.ts';
import { submissionFanout } from './submission-fanout.ts';
import { templatesSeed } from './templates-seed.ts';

export * from './define.ts';
export { auditChain, heartbeat, partitionsMaintain, submissionFanout, templatesSeed };
export { AUDIT_CHAIN_LAG_WARN_MS } from './audit-chain.ts';
export { createAuditJobs, type AuditJobDeps } from './audit.ts';
export { createEffectFanout, createEffectJobs } from './effects.ts';
export { PARTITION_MONTHS_AHEAD } from './partitions.ts';
export { createSubmissionFanout, type FanoutConsumer, type FanoutTarget } from './submission-fanout.ts';
export { createUploadJobs, removeUnattachedUploads, UNATTACHED_AFTER_HOURS } from './uploads-gc.ts';

/**
 * The handler registry: one definition per queue this worker serves. A queue missing here is not worked. The
 * checkpoint, verify and archive handlers need the KMS and storage and come from `createAuditJobs`; the notification,
 * webhook and export handlers need the mailer, the egress guard and the org secrets and come from `createEffectJobs`.
 * `submissionFanout` here has no consumers: `main.ts` swaps it for `createEffectFanout(deps)`, which has them.
 */
export const JOB_DEFINITIONS: readonly AnyJobDefinition[] = [heartbeat, partitionsMaintain, templatesSeed, auditChain, submissionFanout];
