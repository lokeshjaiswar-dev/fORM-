# ADR-0008: CSRF protection through Fetch-Metadata and a custom header, no tokens

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.01 (feature matrix rows WSP-01, WSP-08)

## Context

The builder authenticates to the API with a session cookie (`__Host-fr_sess`, Secure, HttpOnly, SameSite=Lax), so unsafe requests need CSRF protection. The builder (`app.<domain>`) and API (`api.<domain>`) are configured same-site; the respondent runtime is served from a separate registrable domain on SaaS ([ADR-0013](0013-separate-user-content-domain.md)), so a request from respondent content is cross-site. The review aligned the delivery plan with the architecture on this point (F-9). See [`docs/platform/03-architecture.md` §3.2 and §4.2](../platform/03-architecture.md).

## Decision

1. Unsafe methods with cookie authentication need **`Sec-Fetch-Site: same-origin`** and the header **`X-FR-Client: builder`**.
2. CORS on the builder API allows the builder origin only (with credentials), so the preflight for the custom header fails from any other origin.
3. **No CSRF tokens.**
4. API-key requests (`Authorization: Bearer`) are not cookie-authenticated and are not subject to the guard.

## Consequences

- No token storage, rotation or form plumbing in the builder.
- The guard depends on browsers that send Fetch-Metadata; WP-1.01's acceptance includes "cross-site POST without the header is rejected".
- On-prem installs that put respondent content on subdomains of the builder's site keep only CORS between them; the Helm chart documents this and recommends a separate domain.

## Links

- Architecture §3.1 (surfaces), §3.2 step 2, §4.2, §8 control 3
- Delivery plan [WP-1.01](../platform/04-delivery-plan.md)
- Review log [F-9](../platform/05-review-log.md)
