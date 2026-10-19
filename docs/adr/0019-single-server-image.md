# ADR-0019: One `fr-server` image with several entrypoints; runtime SSR embeddable in the API process

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10; planned as ADR-0002 and renumbered when ADR-0002 recorded the batch-2 decisions)
- **Work packages:** WP-1.27 (images, Helm), WP-1.09 (runtime SSR); feature matrix row FND-18

## Context

The platform aims for few deployables, all stateless and horizontally scalable, and small on-prem installs should be able to run one server deployment. Every extra image multiplies signing, SBOMs, scanning, mirroring into air-gapped registries and upgrade testing. See [`docs/platform/03-architecture.md` §0 principle 8, §4.1 and §7.1](../platform/03-architecture.md).

## Decision

1. **One `fr-server` image** (distroless `node:24`) holds the api, runtime SSR, worker and cli bundles, the template packs, licence public keys, the GeoIP database and the disposable-email list. Entrypoints: `server api`, `server runtime`, `server worker`, `server migrate`, `server cli …`.
2. **`fr-worker-pdf`** is `fr-server` plus Chromium, Noto fonts and qpdf, started as `server worker --queues=pdf.*,templates.thumbnail` ([ADR-0009](0009-chromium-pdf.md)); **`fr-builder`** (nginx-unprivileged) serves the static builder.
3. **`RUNTIME_MODE=embedded`**: the API process serves runtime SSR too, so a small install runs one `server` deployment. `runtime.standalone=true` in Helm splits them; the runtime then talks to the API over the internal URL and never accesses the database directly.
4. All images run non-root with a read-only root filesystem and `cap_drop: ALL`, and ship with an SBOM, a cosign signature and third-party notices.

## Consequences

- Workers choose their queues with `WORKER_QUEUES`, so one image serves every worker pool.
- The dev stack runs the API on :8080 with `RUNTIME_MODE=embedded`.
- An air-gapped bundle carries three product images plus pinned third-party images.

## Links

- Architecture §0 principle 8, §1.2 (`apps/runtime` has no DB access), §1.5 (`RUNTIME_MODE`, `WORKER_QUEUES`), §4.1, §7.1, §7.2, §7.3
- Delivery plan [WP-1.09, WP-1.27](../platform/04-delivery-plan.md)
- [ADR-0002](0002-phase0-batch2-decisions.md) (context paragraph: the renumbering)
