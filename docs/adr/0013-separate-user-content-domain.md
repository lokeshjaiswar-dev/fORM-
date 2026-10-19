# ADR-0013: SaaS runtime and user files on a separate registrable domain

- **Status:** Accepted (the domain name itself is decision D13, open)
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work packages:** WP-1.09 (runtime), WP-1.29 (SaaS infrastructure); feature matrix row FND-20

## Context

The first plan served the runtime from `forms.<domain>`. Subdomains of one registrable domain are the **same site**: SameSite cookies flow between them and Fetch-Metadata reports `same-site`. Respondent-controlled content (forms, custom CSS, uploaded files) would then be same-site with the builder and API, weakening the cookie and CSRF protections (F-26). See [`docs/platform/03-architecture.md` §4.2](../platform/03-architecture.md).

## Decision

1. On SaaS, **the runtime and user files are served from a separate registrable domain** (for example `formsuser.in`; the name is decision D13), not a subdomain of the product domain.
2. Builder (`app.<domain>`) and API (`api.<domain>`) stay same-site; the session cookie is `__Host-` scoped to the API host.
3. Uploaded files are served from the user-content domain with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
4. On-prem, hosts are Helm values. The chart documents that subdomains of one site leave only CORS between respondent content and the API, and recommends a separate domain.

## Consequences

- `PUBLIC_RUNTIME_URL` and `PUBLIC_FILES_URL` must be a different registrable domain from the builder and API on SaaS.
- The CSRF guard ([ADR-0008](0008-csrf-fetch-metadata.md)) can rely on `Sec-Fetch-Site` to separate builder traffic from respondent content.
- Custom domains (P3, PUB-10) map onto the runtime host.

## Links

- Architecture §1.5 (`PUBLIC_RUNTIME_URL`, `PUBLIC_FILES_URL`), §4.2, §7.3 (Helm hosts)
- Delivery plan [WP-1.09, WP-1.29](../platform/04-delivery-plan.md), decision D13 (§9)
- Review log [F-26](../platform/05-review-log.md)
