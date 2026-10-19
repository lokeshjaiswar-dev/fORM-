# ADR-0003: Runtime HTML cached by path, per-visitor state from `POST /session`, hash-based CSP

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.09 (feature matrix rows PUB-02, PUB-04, RSP-01, FND-20 runtime)

## Context

The respondent runtime must reach first paint quickly on low-end Android phones over 3G/4G. Server-side rendering of the first page puts interactive fields on screen before the renderer and React load, but SSR output is only cheap if it can be cached. A published definition is immutable, so the HTML can be rendered from a cached `RuntimeFormVersion` as long as nothing per-visitor ends up in it. The review found three ways this could go wrong: a nonce-based CSP cannot sit on cacheable HTML, Trusted Types would break payment and captcha scripts, and a cache key that includes the query string would put prefill values (personal data) into CDN logs and caches (F-25, C-M13). See [`docs/platform/03-architecture.md` §4.1 and §4.5](../platform/03-architecture.md).

## Decision

1. **React SSR first paint plus an immutable version JSON, behind a cache.** `GET /f/:slug` streams the first page (`renderToPipeableStream`) from the cached runtime projection and embeds the projection as JSON. Responses are `Cache-Control: public, s-maxage=60, stale-while-revalidate=600` with `Surrogate-Key: form:<id>`; publish and status changes purge that key through `CdnPurge`.
2. **The cache key is the path only.** The query string is excluded and CDN query logging is off. Prefill is read on the client and then removed from the address bar with `history.replaceState`; `Referrer-Policy: no-referrer`; logs and traces drop query values.
3. **Per-visitor state comes from `POST /f/:slug/session`** (`no-store`): status, public config, render token, visit id and access token. Status that changes what is shown (closed, not yet open, limit reached, password) is re-rendered on the client from `/session`; the server rejects submits to closed forms regardless of what a cached page shows.
4. **Version JSON is immutable**, keyed by version id; `ETag = contentHash`. Password-protected forms are `private, no-store` and the projection is withheld until `/unlock`.
5. **The CSP is hash-based and computed at publish.** The bootstrap script, theme variables and custom CSS are inline blocks whose hashes are stored with the version, so the CSP header is a function of the version, identical for every visitor and cacheable. `script-src` uses `'strict-dynamic'`; `require-trusted-types-for 'script'` is report-only when payment or third-party captcha scripts are present.

## Consequences

- Cached pages are at most 60 s stale; correctness never depends on the cache because the server re-checks status at submit.
- Nothing per-visitor may be rendered into SSR HTML; the WP-1.09 acceptance includes a leak snapshot and an "identical CSP for two visitors of a cached page" test.
- Custom CSS is sanitised at publish (css-tree allowlist) because its hash is fixed into the version.
- `/f/*/submissions` and `/f/*/uploads` bypass the CDN.

## Links

- Architecture [§3.2 request pipeline](../platform/03-architecture.md) (URL scrubbing), §4.1, §4.5, §7.7 (SLOs)
- Delivery plan [WP-1.09](../platform/04-delivery-plan.md)
- Review log [C-M13, F-25](../platform/05-review-log.md)
- Related: [ADR-0013](0013-separate-user-content-domain.md) (where the runtime is served)
