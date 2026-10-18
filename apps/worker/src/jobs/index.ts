import type { AnyJobDefinition } from './define.ts';
import { heartbeat } from './heartbeat.ts';
import { partitionsMaintain } from './partitions.ts';
import { templatesSeed } from './templates-seed.ts';

export * from './define.ts';
export { heartbeat, partitionsMaintain, templatesSeed };
export { PARTITION_MONTHS_AHEAD } from './partitions.ts';

/** The handler registry: one definition per queue this worker serves. A queue missing here is not worked. */
export const JOB_DEFINITIONS: readonly AnyJobDefinition[] = [heartbeat, partitionsMaintain, templatesSeed];
