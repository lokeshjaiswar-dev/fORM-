# ADR-0007: pg-boss as the transactional outbox, one fanout job per event

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-0.14 (worker on pg-boss, feature matrix row FND-16), WP-1.12 (`submission.fanout`), WP-1.16 (notifications)

## Context

pg-boss on Postgres (no Redis) is a fixed input, and Postgres is meant to be the only stateful dependency besides object storage, so on-prem customers run two stateful systems, not six. Side effects of a submission (notifications, webhooks, integrations, workflows, analytics counters) must happen if and only if the submission commits. The feasibility review found that enqueuing one job per effect at 200 submits/s would put too many rows into the queue (F-32), and that email delivery cannot be exactly-once (F-49). See [`docs/platform/03-architecture.md` §0, §2.5 and §5](../platform/03-architecture.md).

## Decision

1. **Transactional outbox:** jobs are enqueued in the business transaction, through the same Drizzle transaction (`SendOptions.tx`, `@form/db` `txExecutor(tx)`).
2. **One fanout job per event.** A submit enqueues one `submission.fanout` job; its handler fans out to the configured effects only and skips the rest. Held statuses enqueue nothing until they are released.
3. **Handlers are idempotent** through `job_effects` (30-day TTL). Every queue declares `retryLimit`, `retryBackoff`, `expireInSeconds`, a dead-letter queue and `singletonKey` where needed.
4. **Email delivery is at-least-once.** A crash between SMTP acceptance and recording the effect can resend; the stable `Message-ID` lets mail clients de-duplicate.
5. Payloads carry ids only; a field that must carry a secret is encrypted with the secrets DEK. Installs above the write-volume target run pg-boss in a separate queue database (`QUEUE_DATABASE_URL`).

## Consequences

- At 200 submits/s the queue sees about 600 to 1,000 job rows/s; analytics are batched in process (COPY every 5 s) and add no per-event jobs.
- Every handler must be safe to run twice.
- pg-boss tables are not under RLS; they hold ids only, and the job envelope ([ADR-0016](0016-signed-job-envelope.md)) stops a job from acting on another org.

## Links

- Architecture §0 principle 2, §2.5 step 5, §5.1, §5.2, §6 (`Queue` port)
- Delivery plan [WP-0.14, WP-1.12, WP-1.16](../platform/04-delivery-plan.md)
- Review log [F-32, F-49](../platform/05-review-log.md)
