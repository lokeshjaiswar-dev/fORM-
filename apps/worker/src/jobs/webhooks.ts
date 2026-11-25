import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { audit, disclosures, secretEnc, txExecutor, uuidV7, uuidV7Time, webhookDeliveries, webhooks, type Tx, type WebhookEvent } from '@form/db';
import { isPortError, JOB_POLICIES, PortError, toIsoInstant, type SubmissionEvent } from '@form/ports';
import type { EffectDeps } from '../effects/deps.ts';
import { recordDisclosure } from '../effects/disclosure.ts';
import { loadSubmission } from '../effects/submission.ts';
import { BodyRefused, renderWebhookBody } from '../effects/webhook/body.ts';
import { buildWebhookPayload } from '../effects/webhook/payload.ts';
import { DELIVERY_ID_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signWebhook, webhookSigningSecret } from '../effects/webhook/sign.ts';
import { scrubSnippet } from '../effects/webhook/snippet.ts';
import { defineJob, type AnyJobDefinition } from './define.ts';
import type { FanoutConsumer } from './submission-fanout.ts';

/*
 * Webhooks (WP-1.18, INT-01): a form's answers posted to an address the owner chose. Three steps, each safe to repeat:
 *
 *   1. `webhooksConsumer` (inside `submission.fanout`): if an enabled webhook of the form subscribes to the event, enqueue ONE
 *      `webhook.fanout` for the response. A form with no webhook costs one indexed read.
 *   2. `webhook.fanout`: one `pending` row of the delivery log per subscribed webhook, and one `webhook.deliver` for it. The rows
 *      and the jobs commit together (the outbox), so a delivery exists exactly when its job does.
 *   3. `webhook.deliver`: build the body (only what the webhook's purposes allow), sign it, send it through the tenant egress
 *      guard, and record what happened. Sending data to an outside address is a disclosure (CONTRIBUTING §5, rule 6): the
 *      answers are filtered by `disclosableFields`, and a row goes into the disclosures ledger.
 *
 * `webhook.deliver` is a `transaction: 'manual'` job: a request may take 30 s, and a database connection held for that long is
 * a connection no other job can use. It reads in one short transaction, calls out with none open, and records in another.
 */

/** Consecutive failed attempts after which a webhook is turned off (architecture §5.2). A success starts the count again. */
export const MAX_CONSECUTIVE_FAILURES = 50;
/** What `webhooks.disabled_reason` says after the automatic turn-off. The count is in the audit record. */
export const AUTO_DISABLED_REASON = 'Turned off automatically after 50 failed deliveries in a row.';
/** The whole request, connect to last byte (architecture §5.2). */
export const DELIVERY_TIMEOUT_MS = 30_000;
/** More of the answer than this is not read: the receiver is misbehaving, and the log keeps 1 KB anyway. */
export const RESPONSE_CAP_BYTES = 64 * 1024;

/** How far the API's clock (a response's `receivedAt`) may be ahead of the database's (`created_at` of its deliveries). */
const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000;

/** The queue's own count of retries, so the last attempt is known when it is made. */
const RETRY_LIMIT = JOB_POLICIES['webhook.deliver'].retryLimit;

/** Which webhook event a response event is. A response is "new" for outside systems when it is released as well as when it is created. */
const EVENT_OF: Readonly<Record<SubmissionEvent, WebhookEvent>> = {
  created: 'submission.created',
  released: 'submission.created',
  updated: 'submission.updated',
};

/** The statuses of a response a webhook may still be sent. A response that was trashed, marked spam or otherwise taken out of circulation since the event is not. */
const DELIVERABLE_STATUSES: readonly string[] = ['complete', 'archived'];

/** The queues this domain works. */
export function webhookJobs(deps: EffectDeps): AnyJobDefinition[] {
  return [webhookFanout(deps), webhookDeliver(deps)];
}

/**
 * The `submission.fanout` consumer of this domain: when an enabled webhook of the form subscribes to the event, enqueue one
 * `webhook.fanout` through the job's transaction. It reads no answer and sends no request itself.
 */
export function webhooksConsumer(deps: EffectDeps): FanoutConsumer {
  return async (target, { tx, log }) => {
    const event = EVENT_OF[target.event];
    const [subscribed] = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(eq(webhooks.formId, target.formId), eq(webhooks.enabled, true), sql`${event} = any(${webhooks.events})`))
      .limit(1);
    if (!subscribed) return;
    // The response id is a UUIDv7 (the submissions CHECK), so the partition key is the moment inside it; it is not taken from anywhere else.
    const receivedAt = uuidV7Time(target.submissionId);
    if (!receivedAt) {
      log.warn({ submissionId: target.submissionId }, 'webhooks: the response id is not a UUIDv7; nothing to fan out');
      return;
    }
    await deps.queue.send(
      'webhook.fanout',
      { orgId: target.orgId, resource: { type: 'form', id: target.formId }, data: { submissionId: target.submissionId, receivedAt: toIsoInstant(receivedAt), formId: target.formId, event } },
      { tx: txExecutor(tx) },
    );
  };
}

/**
 * `webhook.fanout`: the delivery rows of one event of one response. The envelope's resource is the FORM (`resolve_job_org`
 * resolves forms, and the worker already checked that the envelope's org owns it); the webhooks are read under that form.
 * The partition key of the response is the moment inside its id, never the `receivedAt` the job carries.
 */
function webhookFanout(deps: EffectDeps) {
  return defineJob({
    name: 'webhook.fanout',
    perms: [],
    async run({ tx, orgId, job, log }) {
      const { resource, data } = job.envelope;
      const receivedAt = uuidV7Time(data.submissionId);
      if (!receivedAt || data.formId !== resource.id) {
        log.warn({ submissionId: data.submissionId, formId: resource.id }, 'webhook.fanout: the job does not name a response of its form; nothing to deliver');
        return;
      }
      const subscribed = await tx
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(and(eq(webhooks.formId, resource.id), eq(webhooks.enabled, true), sql`${data.event} = any(${webhooks.events})`))
        .orderBy(webhooks.createdAt, webhooks.id);
      // Exactly once per webhook for a new response. The queue is at-least-once: a `submission.fanout` (or this job) that
      // committed but was not marked complete (the worker died in between, the ack hit a connection blip) runs again, and
      // without this check it would insert a second delivery with a new id, which a receiver cannot tell from a new event.
      // The lock makes two runs for the same response take turns, so the second sees the first one's rows (read committed),
      // as `notification.dispatch` does. A replay (`replayOf` set) is an owner's deliberate resend and does not count.
      // Not for `submission.updated`: each edit is an event of its own, and the job does not yet say which edit it is (BL-311).
      let already = new Set<string>();
      if (data.event === 'submission.created' && subscribed.length > 0) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`webhook.fanout:${data.submissionId}:${data.event}`}, 0))`);
        const existing = await tx
          .selectDistinct({ webhookId: webhookDeliveries.webhookId })
          .from(webhookDeliveries)
          .where(
            and(
              inArray(
                webhookDeliveries.webhookId,
                subscribed.map((h) => h.id),
              ),
              // No delivery is older than its response, so this bound lets the planner skip the older monthly partitions. The
              // day of slack is for clocks: `receivedAt` is the API's clock, `created_at` the database's.
              gte(webhookDeliveries.createdAt, new Date(receivedAt.getTime() - CLOCK_SLACK_MS)),
              eq(webhookDeliveries.submissionId, data.submissionId),
              eq(webhookDeliveries.submissionReceivedAt, receivedAt),
              eq(webhookDeliveries.event, data.event),
              isNull(webhookDeliveries.replayOf),
            ),
          );
        already = new Set(existing.map((e) => e.webhookId));
      }
      let created = 0;
      for (const hook of subscribed) {
        job.signal.throwIfAborted();
        if (already.has(hook.id)) {
          log.info({ submissionId: data.submissionId, webhookId: hook.id, event: data.event }, 'webhook.fanout: this response already has its delivery; not sending another');
          continue;
        }
        created += 1;
        const id = uuidV7(deps.now());
        await tx.insert(webhookDeliveries).values({ id, orgId, webhookId: hook.id, event: data.event, submissionId: data.submissionId, submissionReceivedAt: receivedAt, status: 'pending' });
        await deps.queue.send('webhook.deliver', { orgId, resource: { type: 'webhook_delivery', id }, data: { deliveryId: id } }, { tx: txExecutor(tx) });
      }
      log.debug({ submissionId: data.submissionId, event: data.event, deliveries: created }, 'webhook.fanout done');
    },
  });
}

/** What the first read of a delivery found: either something to send, or the reason there is nothing to send. */
type Prepared =
  | { kind: 'done' }
  | {
      kind: 'send';
      delivery: { id: string; createdAt: Date; event: WebhookEvent };
      hook: { id: string; formId: string; url: string; secretId: string };
      submission: { id: string; receivedAt: Date };
      body: string;
      contentType: string;
      sentKeys: string[];
      enc: Record<string, unknown>;
    };

/**
 * What the receiver (or the network) did. `mayHaveSent`: the request may have reached the receiver, so it is a disclosure.
 * `platformFault`: the platform could not even try (the key service did not answer), so it is no failure of the webhook.
 */
type Outcome =
  | { kind: 'answered'; status: number; snippet: string | null }
  | { kind: 'no_answer'; reason: string; mayHaveSent: boolean; platformFault?: true }
  | { kind: 'refused'; reason: string };

/**
 * What the delivery log says when the egress guard turns an address away. FIXED, never the guard's own message: that message
 * names the address the worker's resolver returned ("10.0.0.1 is not a public address"), and the log is shown to every member
 * with `data.route`. A tenant could save a webhook for an internal name and read its private address from the log, which makes
 * the guard a DNS oracle for the platform's own network. The detail goes to the worker's log (see `send`), which tenants cannot read.
 */
export const ADDRESS_REFUSED_REASON = 'the address is not allowed (private, internal or not permitted)';
/** Same rule for a name the resolver could not answer for: the resolver's error text stays out of the tenant's log. */
export const ADDRESS_UNRESOLVED_REASON = 'the address did not resolve';

/** An error's message for the delivery log: scrubbed and cut, because a message can echo what a receiver sent. */
const reasonOf = (prefix: string, err: unknown): string => scrubSnippet(`${prefix}: ${err instanceof Error ? err.message : 'unexpected error'}`) ?? prefix;

/** When the queue will try again, about: its backoff doubles the delay each time up to the cap (it adds jitter, which is not shown). */
function nextAttemptAfter(now: Date, attempt: number): Date {
  const { retryDelaySeconds, retryDelayMaxSeconds } = JOB_POLICIES['webhook.deliver'];
  return new Date(now.getTime() + Math.min(retryDelaySeconds * 2 ** (attempt - 1), retryDelayMaxSeconds) * 1000);
}

/**
 * One delivery row, by id and by the partition key it was made with. `created_at` has microseconds and a JavaScript Date only
 * milliseconds, so the stored value never equals the one read back: `=` would match nothing. A window of a second either side
 * still lets Postgres read the one partition the row is in instead of all of them.
 */
function deliveryKey(d: { id: string; createdAt: Date }) {
  return and(
    eq(webhookDeliveries.id, d.id),
    gte(webhookDeliveries.createdAt, new Date(d.createdAt.getTime() - 1000)),
    lt(webhookDeliveries.createdAt, new Date(d.createdAt.getTime() + 1000)),
  );
}

/** The error a failed attempt throws so the queue retries it. It names the delivery and the reason, never the URL or the body. */
class DeliveryFailed extends Error {
  constructor(deliveryId: string, reason: string) {
    super(`webhook delivery ${deliveryId} failed: ${reason}`);
    this.name = 'DeliveryFailed';
  }
}

/**
 * `webhook.deliver`: one attempt at one delivery.
 *
 *  - 2xx: `succeeded`, and the failure count of the webhook goes back to 0.
 *  - another status, or no answer (`unavailable`: refused, reset, timed out, an answer over 64 KB): `retrying` and the error is
 *    thrown so the queue tries again; on the last attempt it is `dead` instead (nothing more is thrown).
 *  - the egress guard refused the address (`egress_denied`: a private or metadata address, a host that is not allowed): `dead`
 *    at once and no retry, because the same address will be refused again. A name that does not resolve is not a refusal (it can
 *    be a DNS blip): it is retried like any other missing answer.
 *  - a webhook that is turned off or gone, or a response that no longer exists or was set aside: `failed`, not sent.
 * Every attempt that is not a success adds to the webhook's failure count, except one the platform could not make (the key
 * service did not answer); the 50th in a row turns the webhook off.
 *
 * Making the request is at-least-once: if the worker dies after the receiver answered and before the result is recorded, the
 * queue sends it again. The receiver can drop a repeat by the `fORM-Delivery-Id` header, which is the same on every retry.
 */
function webhookDeliver(deps: EffectDeps) {
  return defineJob({
    name: 'webhook.deliver',
    transaction: 'manual',
    perms: [],
    async run({ inTenant, orgId, job, log }) {
      const { deliveryId } = job.envelope.data;
      const prepared = await inTenant((tx) => prepare(tx, deliveryId, job.attempt, log));
      if (prepared.kind === 'done') return;

      const { delivery, hook, submission, body, contentType, sentKeys, enc } = prepared;
      const started = performance.now();
      const outcome = await send(deps, log, { orgId, deliveryId, hook, event: delivery.event, enc, body, contentType });
      const durationMs = Math.round(performance.now() - started);
      const requestHash = createHash('sha256').update(body).digest();

      const lastAttempt = job.attempt > RETRY_LIMIT;
      const succeeded = outcome.kind === 'answered' && outcome.status >= 200 && outcome.status < 300;
      const status: Attempt['status'] = succeeded ? 'succeeded' : outcome.kind === 'refused' || lastAttempt ? 'dead' : 'retrying';
      const sent = outcome.kind === 'answered' || (outcome.kind === 'no_answer' && outcome.mayHaveSent);
      const snippet = outcome.kind === 'answered' ? outcome.snippet : scrubSnippet(`${outcome.kind === 'refused' ? 'not sent' : 'no answer'}: ${outcome.reason}`);
      const now = deps.now();

      await inTenant((tx) =>
        recordAttempt(tx, {
          orgId,
          jobId: job.id,
          delivery,
          hook,
          submission,
          sentKeys,
          status,
          attempt: job.attempt,
          httpStatus: outcome.kind === 'answered' ? outcome.status : null,
          durationMs: outcome.kind === 'refused' ? null : durationMs,
          requestHash: outcome.kind === 'refused' ? null : requestHash,
          snippet,
          nextAttemptAt: status === 'retrying' ? nextAttemptAfter(now, job.attempt) : null,
          sent,
          succeeded,
          countsAgainstWebhook: !(outcome.kind === 'no_answer' && outcome.platformFault === true),
        }),
      );
      log.info(
        { deliveryId, webhookId: hook.id, status, attempt: job.attempt, ...(outcome.kind === 'answered' ? { httpStatus: outcome.status } : {}), ms: durationMs },
        'webhook.deliver: attempt recorded',
      );
      if (status === 'retrying') {
        throw new DeliveryFailed(deliveryId, outcome.kind === 'answered' ? `the receiver answered ${outcome.status}` : outcome.kind === 'no_answer' ? 'no answer from the receiver' : 'refused');
      }
    },
  });
}

/**
 * The first step: read the delivery, its webhook and its response, and build the body, all in one short transaction. A
 * delivery that has nothing to send (settled already, webhook off or gone, response gone or set aside) is settled here as
 * `failed` and the job ends. The sealed secret is read here too (`secret_enc`, which answers only for a system context of the
 * org) and opened later, outside the transaction, because the KMS is a network call.
 */
async function prepare(tx: Tx, deliveryId: string, attempt: number, log: Logger): Promise<Prepared> {
  const [delivery] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!delivery) {
    log.info({ deliveryId }, 'webhook.deliver: no such delivery (its webhook was deleted); nothing to send');
    return { kind: 'done' };
  }
  // The queue can hand the same job over twice (a crash after the result was recorded): a settled delivery is not sent again.
  if (delivery.status === 'succeeded' || delivery.status === 'dead' || delivery.status === 'failed') return { kind: 'done' };

  const settle = async (reason: string): Promise<Prepared> => {
    await tx
      .update(webhookDeliveries)
      .set({ attempt, status: 'failed', responseSnippet: scrubSnippet(`not sent: ${reason}`), nextAttemptAt: null })
      .where(deliveryKey(delivery));
    log.info({ deliveryId, reason }, 'webhook.deliver: not sent');
    return { kind: 'done' };
  };

  const [hook] = await tx.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1);
  if (!hook) return settle('the webhook no longer exists');
  if (!hook.enabled) return settle('the webhook is turned off');
  if (delivery.submissionId === null) return settle('the event has no response to send');
  const loaded = await loadSubmission(tx, { formId: hook.formId, submissionId: delivery.submissionId });
  if (!loaded) return settle('the response no longer exists');
  if (!DELIVERABLE_STATUSES.includes(loaded.row.status)) return settle(`the response is ${loaded.row.status}`);
  // The trash is a column, not a status (see SubmissionRow.trashedAt): a retry or a replay after the owner trashed it sends nothing.
  if (loaded.row.trashedAt !== null) return settle('the response is trashed');

  // A replay is the same event again: it carries the id and the time of the first delivery, so the receiver can tell it is a repeat.
  let event = { id: delivery.id, createdAt: delivery.createdAt };
  for (let next = delivery.replayOf, hops = 0; next !== null && hops < 8; hops++) {
    const [origin] = await tx
      .select({ id: webhookDeliveries.id, createdAt: webhookDeliveries.createdAt, replayOf: webhookDeliveries.replayOf })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, next), eq(webhookDeliveries.webhookId, hook.id)))
      .limit(1);
    if (!origin) break;
    event = { id: origin.id, createdAt: origin.createdAt };
    next = origin.replayOf;
  }

  const built = buildWebhookPayload({
    eventId: event.id,
    event: delivery.event,
    createdAt: event.createdAt,
    formId: hook.formId,
    submission: { id: loaded.row.id, receivedAt: loaded.row.receivedAt, answers: loaded.row.answers },
    definition: loaded.definition,
    compiled: loaded.compiled,
    webhook: { purposeIds: hook.purposeIds, fieldKeys: hook.fieldKeys, keyBy: hook.keyBy },
  });
  // The format and the mapping come after the disclosure filter: they reshape what `built` already allows and add nothing to it.
  let rendered: ReturnType<typeof renderWebhookBody>;
  try {
    rendered = renderWebhookBody(built, { bodyFormat: hook.bodyFormat, payloadMapping: hook.payloadMapping });
  } catch (err) {
    if (err instanceof BodyRefused) return settle(err.message);
    throw err;
  }
  const enc = await secretEnc(tx, hook.secretId);
  if (!enc) return settle('the signing secret no longer exists');
  return {
    kind: 'send',
    delivery: { id: delivery.id, createdAt: delivery.createdAt, event: delivery.event },
    hook: { id: hook.id, formId: hook.formId, url: hook.url, secretId: hook.secretId },
    submission: { id: loaded.row.id, receivedAt: loaded.row.receivedAt },
    body: rendered.body,
    contentType: rendered.contentType,
    sentKeys: rendered.sentKeys,
    enc,
  };
}

/**
 * The second step, with no transaction open: open the secret, sign, and send through the tenant egress guard. Every way it can
 * go wrong is an `Outcome`; nothing here throws for a receiver's or a network's doing, and nothing that is logged or stored
 * holds the URL's path or query, the secret or the body.
 */
async function send(
  deps: EffectDeps,
  log: Logger,
  o: { orgId: string; deliveryId: string; hook: { url: string; secretId: string }; event: WebhookEvent; enc: Record<string, unknown>; body: string; contentType: string },
): Promise<Outcome> {
  let url: URL;
  try {
    url = new URL(o.hook.url);
  } catch {
    return { kind: 'refused', reason: 'the webhook address is not a valid URL' };
  }

  let secret: Uint8Array;
  try {
    secret = await deps.orgSecrets.open({ orgId: o.orgId, secretId: o.hook.secretId, kind: 'webhook_hmac' }, o.enc);
  } catch (err) {
    // The KMS being down is worth another try; a secret that does not open (changed, or another org's) never will.
    if (isPortError(err, 'unavailable')) return { kind: 'no_answer', reason: 'the signing secret could not be read (the key service did not answer)', mayHaveSent: false, platformFault: true };
    return { kind: 'refused', reason: 'the signing secret cannot be opened' };
  }

  const seconds = Math.floor(deps.now().getTime() / 1000);
  try {
    const res = await deps.tenantHttp(url, {
      method: 'POST',
      headers: {
        'content-type': o.contentType,
        'user-agent': deps.config.webhookUserAgent,
        // The key is the text the owner was shown (`whsec_...`), not the sealed bytes; see `webhookSigningSecret`.
        [SIGNATURE_HEADER]: signWebhook(webhookSigningSecret(secret), o.body, seconds),
        [DELIVERY_ID_HEADER]: o.deliveryId,
        [EVENT_HEADER]: o.event,
      },
      body: o.body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxResponseBytes: RESPONSE_CAP_BYTES,
    });
    return { kind: 'answered', status: res.status, snippet: scrubSnippet(res.text()) };
  } catch (err) {
    if (isPortError(err, 'egress_denied')) {
      // The guard's message holds the host and the address the resolver returned. It goes to the worker's log (which has no
      // path, query, secret or body in it) and NEVER to the delivery row, which members read: see ADDRESS_REFUSED_REASON.
      // The guard keeps the resolver's own error as the cause when the name did not resolve: that may be a DNS blip, not a
      // refusal of the address, so it is retried like `assertEndpoint` retries it. A policy refusal has no cause and is final.
      if (err.cause !== undefined) {
        log.info({ deliveryId: o.deliveryId, guard: err.message }, 'webhook.deliver: the address did not resolve');
        return { kind: 'no_answer', reason: ADDRESS_UNRESOLVED_REASON, mayHaveSent: false };
      }
      log.warn({ deliveryId: o.deliveryId, guard: err.message }, 'webhook.deliver: the egress guard refused the address');
      return { kind: 'refused', reason: ADDRESS_REFUSED_REASON };
    }
    if (err instanceof PortError && err.code === 'invalid_argument') return { kind: 'refused', reason: 'the webhook address is not an http(s) URL' };
    // Network failure, timeout or an answer over the cap: the request may have reached the receiver. Anything else is a bug; it is retried too.
    return { kind: 'no_answer', reason: reasonOf('the request failed', err), mayHaveSent: true };
  }
}

interface Attempt {
  orgId: string;
  jobId: string;
  delivery: { id: string; createdAt: Date };
  hook: { id: string; formId: string; url: string };
  submission: { id: string; receivedAt: Date };
  sentKeys: string[];
  status: 'succeeded' | 'retrying' | 'dead';
  attempt: number;
  httpStatus: number | null;
  durationMs: number | null;
  requestHash: Uint8Array | null;
  snippet: string | null;
  nextAttemptAt: Date | null;
  /** The request may have reached the receiver: the answers left, so the ledger says so. */
  sent: boolean;
  succeeded: boolean;
  /** False when the platform was at fault (the KMS was down): such an attempt is not a failure of the webhook and never turns it off. */
  countsAgainstWebhook: boolean;
}

/**
 * The third step, in one transaction: the result on the delivery row, the disclosures row when the answers may have left, and
 * the webhook's failure count (a success resets it; the 50th failure in a row turns the webhook off, with an audit record).
 */
async function recordAttempt(tx: Tx, a: Attempt): Promise<void> {
  await tx
    .update(webhookDeliveries)
    .set({
      attempt: a.attempt,
      status: a.status,
      httpStatus: a.httpStatus,
      durationMs: a.durationMs,
      requestHash: a.requestHash,
      responseSnippet: a.snippet,
      nextAttemptAt: a.nextAttemptAt,
    })
    .where(deliveryKey(a.delivery));

  if (a.sent) await recordOnce(tx, a);

  if (a.succeeded) {
    // Only a webhook that has failures is written, so a healthy one costs no row version per delivery.
    await tx.update(webhooks).set({ consecutiveFailures: 0 }).where(and(eq(webhooks.id, a.hook.id), sql`${webhooks.consecutiveFailures} <> 0`));
    return;
  }
  if (!a.countsAgainstWebhook) return;
  const [counted] = await tx
    .update(webhooks)
    .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
    .where(eq(webhooks.id, a.hook.id))
    .returning({ failures: webhooks.consecutiveFailures });
  if (!counted || counted.failures < MAX_CONSECUTIVE_FAILURES) return;

  // `enabled` in the WHERE makes this fire once: the transaction that flips it gets the row, a concurrent one gets none. The
  // revision moves too, so an owner saving the old settings at the same moment is told to reload instead of switching it back on.
  const [turnedOff] = await tx
    .update(webhooks)
    .set({ enabled: false, disabledReason: AUTO_DISABLED_REASON, rev: sql`${webhooks.rev} + 1`, updatedAt: new Date() })
    .where(and(eq(webhooks.id, a.hook.id), eq(webhooks.enabled, true)))
    .returning({ id: webhooks.id });
  if (!turnedOff) return;
  await audit.append(tx, a.orgId, {
    actorKind: 'system',
    action: 'webhook.disabled',
    resourceType: 'webhook',
    resourceId: a.hook.id,
    formId: a.hook.formId,
    outcome: 'success',
    reason: 'consecutive_failures',
    requestId: `job:${a.jobId}`,
    metadata: { consecutiveFailures: counted.failures, deliveryId: a.delivery.id, status: a.status, httpStatus: a.httpStatus },
  });
}

/**
 * One ledger row per delivery, not one per retry: a row of this webhook for this response written since the delivery was
 * made means an earlier attempt of it already said the answers left. A replay is a new delivery, so it adds its own row.
 */
async function recordOnce(tx: Tx, a: Attempt): Promise<void> {
  const [already] = await tx
    .select({ id: disclosures.id })
    .from(disclosures)
    .where(
      and(
        eq(disclosures.recipientKind, 'webhook'),
        eq(disclosures.recipientId, a.hook.id),
        eq(disclosures.submissionId, a.submission.id),
        eq(disclosures.submissionReceivedAt, a.submission.receivedAt),
        gte(disclosures.at, a.delivery.createdAt),
      ),
    )
    .limit(1);
  if (already) return;
  await recordDisclosure(tx, {
    orgId: a.orgId,
    submissionId: a.submission.id,
    submissionReceivedAt: a.submission.receivedAt,
    recipient: { kind: 'webhook', id: a.hook.id },
    displayName: hostOf(a.hook.url),
    fieldKeys: a.sentKeys,
  });
}

/** What the ledger shows for the recipient: the host of the webhook address, never its path, query or credentials. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || 'webhook';
  } catch {
    return 'webhook';
  }
}
