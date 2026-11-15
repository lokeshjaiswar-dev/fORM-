import pg from 'pg';
import { afterAll, beforeAll, describe, inject, vi } from 'vitest';
import { createPostgresSearchIndex } from '@form/adapters/search';
import { createDb, provision, txExecutor, withTenant, type DbHandle } from '@form/db';
import { createTestDatabase, runSearchIndexContract } from '@form/testkit';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * BL-262: the SearchIndex contract gave its documents `receivedAt = now - 60 s`, and `submission_search` has partitions
 * from the current month onward, so in the first minute of every UTC month the documents had no partition and the
 * contract failed (a monthly flake). This runs the same contract against Postgres with the clock set 20 seconds into the
 * current month, which is when the old formula fails; it passes on any day because the contract keeps its documents in
 * the current month.
 *
 * Only `Date` is faked, and only for this file: the partitions were made by the migrations at the real time, which is in
 * the same month, so the month the contract sees is the month the database has.
 */

let owner: pg.Pool;
let app: DbHandle;

describe('the Postgres search index, 20 seconds into a UTC month (BL-262)', () => {
  beforeAll(async () => {
    const adminUrl = inject('pgAdminUrl');
    const database = await createTestDatabase(adminUrl, 'fr_worker_month_edge');
    const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
    owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 2 });
    app = createDb(urls.fr_app, { max: 4, applicationName: 'fr-worker-month-edge-test' });
    const now = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 20)));
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await owner?.end();
  });

  const inTenant = <T>(orgId: string, fn: (sql: ReturnType<typeof txExecutor>) => Promise<T>) =>
    withTenant(app.db, { orgId, actor: 'system', requestId: 'month-edge' }, (tx) => fn(txExecutor(tx)));

  runSearchIndexContract('Postgres FTS (submission_search) as fr_app, 20 s into the month', () => ({ impl: createPostgresSearchIndex({ inTenant }) }));
});
