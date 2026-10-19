# ADR-0017: In-house authentication on our own tables

- **Status:** Accepted (delivery plan decision D4: decided)
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.01 (feature matrix rows WSP-01, WSP-08; CMP-21 for builder-user data)

## Context

The auth library was an open decision (D4). The platform must run air-gapped, send no telemetry, keep identity data in its own Postgres under RLS and the audit log, and leave a clean seam for enterprise SSO through BoxyHQ Jackson in P3. A third-party auth framework brings its own tables, sessions and network expectations. See [`docs/platform/03-architecture.md` §3.3](../platform/03-architecture.md).

## Decision

1. **Authentication is built in-house** on the architecture's identity tables, with no third-party auth framework.
2. Building blocks: argon2id passwords (`@node-rs/argon2`), magic links, Google and Microsoft OIDC through `openid-client` (SaaS only), server-side sessions in the `__Host-fr_sess` cookie with rotation on privilege change, password reset, TOTP 2FA with 10 hashed recovery codes, and per-IP and per-account throttling.
3. CSRF is the Fetch-Metadata and header guard of [ADR-0008](0008-csrf-fetch-metadata.md).
4. Every auth event is audited, failures and denials included.
5. SSO, SCIM and LDAP arrive in P3 through Jackson, behind the same session model.

## Consequences

- Works offline and air-gapped; OIDC is hidden when egress is off. Without SMTP, admins issue one-time codes for invites, resets and DSR identity checks.
- The team owns the security of the auth code: WP-1.01 includes a session-fixation test and CODEOWNERS cover `authz/`.
- Login and session lookups before a tenant is known go through the definer functions `auth_user_by_email` and `auth_session` ([ADR-0015](0015-rls-tenancy-and-definer-functions.md)).

## Links

- Architecture §2.1 (definer functions), §3.2 (pipeline), §3.3 (auth routes), §3.5 (`auth_login`, `auth_any` limits), §6 (Mailer fallback), §8 control 3
- Delivery plan [WP-1.01](../platform/04-delivery-plan.md), decision D4 (§9)
- Review log [F-9](../platform/05-review-log.md)
