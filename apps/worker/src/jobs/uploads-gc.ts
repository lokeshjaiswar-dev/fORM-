import { sql } from 'drizzle-orm';
import { orgsDueFor, withTenant, type Db } from '@form/db';
import type { Logger } from 'pino';
import type { UploadStore } from '../file-store.ts';
import { defineJob, type AnyJobDefinition } from './define.ts';

/** A file nobody's answers name is removed this long after it was uploaded (architecture §4.6: "unattached files after 24 h"). */
export const UNATTACHED_AFTER_HOURS = 24;
const BATCH = 200;

export interface UploadGcOptions {
  files: UploadStore;
  log?: Logger | undefined;
  /** The job's signal (`job.signal`): the sweep stops between batches once it is aborted. */
  signal?: { throwIfAborted(): void } | undefined;
  requestId?: string;
  /** Test hook: the age, in hours, past which an unattached file goes. */
  afterHours?: number;
  batch?: number;
}

/**
 * Removes the files of one org that no submission holds and that are older than `afterHours`: the row first, in its
 * own committed transaction, then the bytes. In that order a crash leaves bytes with no row (harmless, and found by a
 * reconciliation of the store) and never a row with no bytes under a submission. A file counts as held when a
 * submission's insert linked it (`form_files.submission_id`, set by the insert trigger) and, for one that was never
 * linked (or lost its link when its submission was deleted), when any submission of the form still names its id.
 * A submission that lands while the sweep runs wins in all but a few milliseconds: the DELETE re-checks, row by row,
 * that the file is still unheld when it gets to it. (A respondent who held the page open for a day and submits in the
 * very moment the sweep takes their file gets a missing file, and the API says so at download.)
 *
 * Deleting a submission un-holds its files (the link is `on delete set null`), so this sweep is also what removes the
 * bytes of a deleted submission, within the hour for any file older than a day.
 */
export async function removeUnattachedUploads(db: Db, orgId: string, o: UploadGcOptions): Promise<number> {
  const hours = o.afterHours ?? UNATTACHED_AFTER_HOURS;
  const limit = o.batch ?? BATCH;
  let total = 0;
  for (;;) {
    o.signal?.throwIfAborted();
    const ids = await withTenant(db, { orgId, actor: 'system', requestId: o.requestId ?? 'job:uploads.gc', perms: [] }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        delete from form_files f
        where f.id in (
          select g.id from form_files g
          where g.org_id = ${orgId}::uuid
            and g.submission_id is null
            and g.created_at < now() - make_interval(hours => ${hours}::int)
            and not exists (
              select 1 from form_submissions s
              where s.org_id = g.org_id and s.form_id = g.form_id and s.submitted_at >= g.created_at
                and s.answers::text like '%' || g.id::text || '%')
          order by g.created_at
          limit ${limit}::int)
          and f.submission_id is null
        returning f.id`);
      return rows.map((r) => r.id);
    });
    for (const id of ids) {
      try {
        await o.files.remove(id);
      } catch (err) {
        // The row is gone, so nothing refers to the bytes: a failed removal is a leftover to clean up, not a failure.
        o.log?.warn({ err, orgId, fileId: id }, 'could not remove the bytes of an unattached upload');
      }
    }
    total += ids.length;
    if (ids.length < limit) return total;
  }
}

/**
 * `drafts.expire`: the upload GC of architecture §4.6 (there is no separate queue for it; see `JobData`). An org-spanning
 * sweep: it lists the orgs through `orgs_due_for('drafts.expire')` and runs one tenant transaction per org as the
 * system actor. The partial-submission expiry the queue is named for arrives with the save-and-resume work.
 */
export function createUploadJobs(deps: { files: UploadStore }): AnyJobDefinition[] {
  return [
    defineJob({
      name: 'drafts.expire',
      perms: [],
      cron: '20 * * * *',
      async run({ db, log, job }) {
        for (const orgId of await orgsDueFor(db, 'drafts.expire')) {
          job.signal.throwIfAborted();
          const removed = await removeUnattachedUploads(db, orgId, { files: deps.files, log, signal: job.signal, requestId: `job:${job.id}` });
          if (removed > 0) log.info({ orgId, removed }, 'unattached uploads removed');
        }
      },
    }),
  ];
}
