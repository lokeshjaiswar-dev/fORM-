import { auditChain } from './audit-chain.ts';
import type { AnyJobDefinition } from './define.ts';
import { heartbeat } from './heartbeat.ts';
import { partitionsMaintain } from './partitions.ts';
import { templatesSeed } from './templates-seed.ts';

export * from './define.ts';
export { auditChain, heartbeat, partitionsMaintain, templatesSeed };
export { AUDIT_CHAIN_LAG_WARN_MS } from './audit-chain.ts';
export { createAuditJobs, type AuditJobDeps } from './audit.ts';
export { PARTITION_MONTHS_AHEAD } from './partitions.ts';

/**
 * The handler registry: one definition per queue this worker serves. A queue missing here is not worked. The
 * checkpoint, verify and archive handlers need the KMS and storage and come from `createAuditJobs`.
 */
export const JOB_DEFINITIONS: readonly AnyJobDefinition[] = [heartbeat, partitionsMaintain, templatesSeed, auditChain];
