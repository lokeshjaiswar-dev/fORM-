import { createPartitions, PARTITIONED_TABLES } from '@form/db';
import { defineJob } from './define.ts';

/** Months created ahead of the current one (architecture §2.4). */
export const PARTITION_MONTHS_AHEAD = 3;

/** `create_partitions()` for every partitioned table: in schema `parts`, RLS forced, nothing granted (F-1, F-2). */
export const partitionsMaintain = defineJob({
  name: 'partitions.maintain',
  perms: [],
  cron: '15 0 * * *',
  async run({ db, log, job }) {
    for (const table of PARTITIONED_TABLES) {
      job.signal.throwIfAborted();
      const created = await createPartitions(db, table, PARTITION_MONTHS_AHEAD);
      if (created.length > 0) log.info({ table, created }, 'partitions created');
    }
  },
});
