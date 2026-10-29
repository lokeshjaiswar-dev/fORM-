import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JOB_POLICIES, toIsoInstant, type JobRequest, type Queue, type ReceivedJob, type Worker } from '@form/ports';
import { expectPortError, useSubject, type ContractSetup, type ContractSubject } from './contract.ts';

export interface QueueContractSubject extends ContractSubject<Queue> {
  /** An org-scope `system.heartbeat` request whose resource the queue resolves to that org. */
  orgRequest(): JobRequest<'system.heartbeat'> & { orgId: string };
  /** A producer on the same backend signing with a key the subject does not hold: none of its jobs may run. */
  forger: Queue;
  /** Whether the job was moved to its queue's dead letters (retries spent, or the envelope refused). */
  deadLettered(jobId: string): Promise<boolean>;
}

type Heartbeat = ReceivedJob<'system.heartbeat'>;
const NAME = 'system.heartbeat';

/**
 * The Queue port as handlers rely on it (architecture §5, ADR-0016), on `system.heartbeat`: signed envelopes, org
 * scope, singletons, retries then dead letters (`JOB_POLICIES`), delayed starts and UTC cron. The subject should
 * install the queue with a short retry delay. Cases tag jobs with their own resource ids, so they share one worker.
 */
export function runQueueContract(label: string, setup: ContractSetup<QueueContractSubject>): void {
  describe(`Queue contract: ${label}`, () => {
    const subject = useSubject(setup);
    const q = () => subject().impl;
    const handlers = new Map<string, (job: Heartbeat) => Promise<void>>();
    let worker: Worker | undefined;

    beforeAll(async () => {
      worker = await q().work(NAME, async (job) => handlers.get(job.envelope.resource.id)?.(job), { pollIntervalMs: 500 });
    });
    afterAll(async () => {
      await worker?.stop();
    });

    const tag = () => `contract-${randomUUID()}`;
    const system = (id: string): JobRequest<'system.heartbeat'> => ({ orgId: null, resource: { type: 'system', id }, data: {} });
    /** The jobs a handler saw, and whether each one's signal was already aborted when it started. */
    const collect = (id: string, run?: (job: Heartbeat) => Promise<void>) => {
      const seen: (Heartbeat & { abortedAtStart: boolean })[] = [];
      handlers.set(id, async (job) => {
        seen.push({ ...job, abortedAtStart: job.signal.aborted });
        await run?.(job);
      });
      return seen;
    };
    const until = <T>(fn: () => T | Promise<T>, timeout = 20_000) => vi.waitFor(fn, { timeout, interval: 200 });

    it('hands a signed job to its handler, once', async () => {
      const id = tag();
      const seen = collect(id);
      const jobId = await q().send(NAME, system(id));
      expect(jobId).toEqual(expect.any(String));
      await until(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({ id: jobId, name: NAME, attempt: 1, envelope: { v: 1, orgId: null, resource: { type: 'system', id }, data: {}, sig: expect.any(String) } });
      expect(seen[0]?.abortedAtStart).toBe(false);
      await new Promise((r) => setTimeout(r, 1500));
      expect(seen).toHaveLength(1);
    });

    it('carries the org of an org-scope job', async () => {
      const request = subject().orgRequest();
      const seen = collect(request.resource.id);
      await q().send(NAME, request);
      await until(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.envelope).toMatchObject({ orgId: request.orgId, resource: request.resource });
    });

    it('keeps one waiting job per singleton key on a coalescing queue', async () => {
      // audit.chain coalesces (JOB_POLICIES); nothing works it here, so both sends find the first one waiting.
      const orgId = subject().orgRequest().orgId;
      const request: JobRequest<'audit.chain'> = { orgId, resource: { type: 'audit_chain', id: orgId }, data: {} };
      const key = `contract:${randomUUID()}`;
      const startAfter = toIsoInstant(new Date(Date.now() + 3_600_000));
      expect(JOB_POLICIES['audit.chain'].coalesceQueued).toBe(true);
      expect(await q().send('audit.chain', request, { singletonKey: key, startAfter })).toEqual(expect.any(String));
      expect(await q().send('audit.chain', request, { singletonKey: key, startAfter })).toBeNull();
      expect(await q().send('audit.chain', request, { singletonKey: `${key}:other`, startAfter })).toEqual(expect.any(String));
    });

    it('refuses a singleton key on a queue that cannot honour it', async () => {
      expect(JOB_POLICIES[NAME]).toMatchObject({ coalesceQueued: false, exclusive: false });
      await expectPortError(q().send(NAME, system(tag()), { singletonKey: 'k' }), 'unsupported');
    });

    it('does not start a job before startAfter', async () => {
      const id = tag();
      const seen = collect(id);
      const startAfter = new Date(Date.now() + 3000);
      await q().send(NAME, system(id), { startAfter: toIsoInstant(startAfter) });
      await until(() => expect(seen).toHaveLength(1));
      expect(Date.now()).toBeGreaterThanOrEqual(startAfter.getTime() - 250);
    });

    it(`retries a failing job ${JOB_POLICIES[NAME].retryLimit} time(s), then dead-letters it`, async () => {
      const id = tag();
      const seen = collect(id, async () => {
        throw new Error('handler always fails');
      });
      const jobId = (await q().send(NAME, system(id)))!;
      const attempts = JOB_POLICIES[NAME].retryLimit + 1;
      await until(async () => expect(await subject().deadLettered(jobId)).toBe(true), 45_000);
      expect(seen.map((j) => j.attempt)).toEqual(Array.from({ length: attempts }, (_, i) => i + 1));
    });

    it('never runs a job signed with a key it does not hold, and dead-letters it', async () => {
      const id = tag();
      const seen = collect(id);
      const jobId = (await subject().forger.send(NAME, system(id)))!;
      await until(async () => expect(await subject().deadLettered(jobId)).toBe(true));
      expect(seen).toEqual([]);
    });

    it('runs a scheduled job on its UTC cron, signed like any other', { timeout: 150_000 }, async () => {
      const id = tag();
      const seen = collect(id);
      await q().schedule(NAME, '* * * * *', system(id));
      try {
        await until(() => expect(seen.length).toBeGreaterThanOrEqual(1), 130_000);
        expect(seen[0]?.envelope).toMatchObject({ orgId: null, resource: { type: 'system', id } });
      } finally {
        await q().unschedule(NAME);
      }
    });
  });
}
