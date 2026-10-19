# ADR-0016: Signed job envelope with org re-derivation

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10; the as-built details come from WP-0.14)
- **Work package:** WP-0.14 (feature matrix row FND-16)

## Context

pg-boss tables are not under RLS, and `fr_app` can insert into `pgboss.job`. A job payload that simply named an `orgId` would let any code path (or an attacker with an injection) make a handler act inside another org's tenant context; payloads could also carry secrets (F-23). See [`docs/platform/03-architecture.md` §5.1](../platform/03-architecture.md).

## Decision

1. **Every job is an envelope** `{ v: 1, orgId, resource: { type, id }, data, sig }`, where `sig` is an HMAC over the rest with a worker-held key.
2. **Handlers verify `sig`, re-derive the org** with the definer function `resolve_job_org(resource_type, resource_id)` and abort on mismatch, before entering `withTenant({ orgId, actor: 'system', perms: [job-specific minimal set] })`.
3. **Payloads carry ids only.** A field that must carry a secret (magic link, OTP code, invite token for `email.send`) is encrypted with the secrets DEK, and auth queues have a 1-day archive retention.

As built in WP-0.14:

- `sig` is `<keyId>.<base64url HMAC-SHA256>` over the canonical JSON (sorted keys) of `{ v, queue, orgId, resource, data }`. **The queue name is signed**, so an envelope cannot be replayed into another handler.
- `JOB_SIGNING_KEYS` (`JOB_SIGNING_KEYS_FILE`) is a key ring of `id:base64url` keys of at least 32 bytes: the first signs, all verify.
- **Queue scope** (`JOBS` in `@form/ports`) is checked too: `org` jobs need an org, `system` jobs must have none, and `system.heartbeat` has scope `any` (with an org it makes one RLS round trip in that tenant and leaves an audit record; from cron it pings the database).
- **A rejected envelope never runs** (malformed, scope mismatch, unknown key, bad signature, resource missing or of a type `resolve_job_org` does not know, org mismatch). It gets a `job.rejected` denied audit record on its own connection, filed under the org that owns the resource when the database names one, and **goes straight to the dead-letter queue**.
- Every queue `<name>` has the dead-letter queue `<name>.dead`; retry, expiry, exclusivity and concurrency per queue are `JOB_POLICIES` in `@form/ports`. Queues that the architecture's §5.2 table lists without a retry value keep `DEFAULT_JOB_POLICY` (2 retries, backoff from 30 s up to 1 h, 15-minute expiry), so a crash or a shutdown still retries them. `exclusive` queues use pg-boss's `singleton` policy.

## Consequences

- An arbitrary insert into `pgboss.job` cannot act on another org: cross-org action needs the signing key and a resource that really belongs to the claimed org.
- **Known limitation (BL-072):** the HMAC covers no job id, nonce or issue time, so a valid envelope can be re-inserted and run again, within the same org and resource only. Handlers are idempotent through `job_effects` ([ADR-0007](0007-pg-boss-outbox.md)), which bounds the effect of a replay. Signing an `issuedAt` with a maximum age, or the singleton key or job id, would close it.

## Links

- Architecture §1.5 (`JOB_SIGNING_KEYS_FILE`), §2.1 (`resolve_job_org`), §5.1, §6 (`Queue` port: `send(name, JobRequest)` signs into a `JobEnvelope`)
- Delivery plan [WP-0.14](../platform/04-delivery-plan.md)
- Review log [F-23](../platform/05-review-log.md)
- Backlog [BL-066, BL-072](../platform/backlog.md)
- Related: [ADR-0015](0015-rls-tenancy-and-definer-functions.md)
