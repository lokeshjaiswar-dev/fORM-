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

## As built (WP-1.01)

- The guard is an `onRequest` hook (`apps/api/src/modules/auth/csrf.ts`). It applies to every unsafe request that carries the `__Host-fr_sess` cookie, and to every unsafe `/v1/auth/*` request even without one, so a cross-site page cannot sign a victim into another account (login CSRF).
- `Sec-Fetch-Site: same-origin` passes. `same-site` passes only together with an `Origin` equal to the configured builder origin (`PUBLIC_BUILDER_URL`): on SaaS the builder (`app.<domain>`) and the API (`api.<domain>`) are sibling hosts of one site, so the browser reports `same-site` for the builder's own calls, while respondent pages live on another registrable domain (ADR-0013). A missing `Sec-Fetch-Site`, `cross-site` and `none` are refused.
- A refusal first counts against the caller's per-IP `auth_any` budget (architecture §3.5); past it the answer is `429` and nothing more is audited. Otherwise it is `403 CSRF_REJECTED`, audited by the error handler as `request.authorize` with the reason `csrf_missing_client_header`, `csrf_cross_site` or `csrf_no_fetch_metadata`. So cross-site requests and junk cookies cannot flood the audit chain.
- Exempt: `POST /v1/csp-reports` (`config.csrf: false`; browsers send reports without custom headers) and requests authenticated by the development header `X-FR-Dev-User` without a cookie (tests and local development only; refused in production; a sign-out with it is still audited, with no session).
- Tests: `apps/api/test/auth.int.test.ts` (cross-site POST with the cookie but without the header, with the header but cross-site, without Fetch-Metadata, same-site from a sibling that is not the builder) and `apps/builder/e2e/auth.stack.spec.ts` (a form posted from another site, and a builder fetch without the header, both refused while the session stays).

## Links

- Architecture §3.1 (surfaces), §3.2 step 2, §4.2, §8 control 3
- Delivery plan [WP-1.01](../platform/04-delivery-plan.md)
- Review log [F-9](../platform/05-review-log.md)
