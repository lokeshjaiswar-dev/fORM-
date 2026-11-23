# ADR-0023a: Security review of ADR-0023 (fORM- and DMS+ integration)

- **Status:** Accepted as binding amendments to [ADR-0023](0023-dmsplus-integration-and-formplus-replacement.md)
- **Date:** 2026-11-23

Opus did this review in place of Fable, under the founder rule from 4 Nov.

**What I checked myself (read-only).** These dossier claims were confirmed at origin/dev on .54 and on local `dev`:
- `createSubmission` sits in a group with only `tenant.database`: no throttle, no IP whitelist, no `verify.token` (dms-api:routes/api.php:575-580).
- `multiple-document-upload-new` does `User::find($request->user_id); auth()->login($user)` (dms-api:app/Http/Controllers/Api/v1/DocumentController.php:1189-1196, routed at routes/api.php:589).
- `VerifyToken` decodes RS256 with a fixed key and then runs `User::find(sub)`. It logs the raw token on expired, bad-signature and unexpected errors (dms-api:app/Http/Middleware/VerifyToken.php:~106-114).
- `AppTokenAuth` looks tokens up in plaintext (`AppToken::where('token',$token)`).
- Tenant resolution falls back from the header to `?tenant_id`, then `Referer`, `X-Custom-Referer` and `X-Workspace-Id`. On localhost the custom referer is trusted (dms-api:app/Http/Middleware/InitializeTenantDatabase.php:143-191).
- `setCookie` writes `name=value; path=/; domain=.<DISPATCH_DOMAIN>` with no HttpOnly, Secure or SameSite (auth-frontend:src/components/Cookies/setCookie.tsx:1-12).
- Committed fallback bearer JWTs exist; value not printed (monorepo:apps/frontend/dms-ui/lib/interceptors/dms.interceptor.ts:60 and workflow-ui/lib/interceptors/dms.interceptor.ts:50).
- storage-api `*-new` routes sit under `tenant.database` only (storage-api:routes/api.php:14-19).
- **New finding:** storage-api `GET /api/media/storage` runs a shell `df -h` and returns disk details with no middleware (storage-api:routes/api.php:~20-22).
- `projectForRuntime` strips only `note` and origin stamps from blocks, so `apiOptions` and `validation.api` credentials reach the browser (fORM-:packages/logic/src/projectForRuntime.ts:32-40).
- fORM- `identify()` accepts only the session cookie or the dev header (fORM-:apps/api/src/auth.ts:121-144).
- fORM- sends `frame-ancestors 'none'` (fORM-:apps/builder/security/headers.ts:61).
- `TRUST_PROXY` refuses `true` (fORM-:apps/api/src/config.ts:27-44).

Anything else below that cites the dossier was not re-verified.

---

## 1. Threat model summary

**Assets**
- DMS Passport JWTs. They live about 365 days, have no revocation check, carry no tenant claim, and sit in JS-readable cookies scoped to `.<domain>`.
- Tenant master records, and confidential or restricted masters and folders.
- Respondent PII: answers, files and signatures.
- fORM- sessions.
- Service credentials: app token, `X-Service-Token`, HMAC keys, the ES256 ticket key, KMS keys and `JOB_SIGNING_KEYS`.
- Flow+ approval decisions.
- The integrity of master definitions, which Form+ renders on the shared DMS origin.

**Trust boundaries**
1. Browser to the DMS host (`dms.<domain>`). Form+, dms-ui, workflow-ui, the APIs and the new `fr-gateway` share one origin.
2. Browser to `forms.<domain>`. This is a different host but the **same site**, so the DMS `token` cookie is sent to fORM- on every request.
3. fORM- to dms-api, storage-api and workflow-api. There is no real service principal before P5, and the sealed user JWT is used instead.
4. workflow-api to fORM-, through launch tickets and HMAC callbacks.
5. Kafka (MSK). It is PLAINTEXT with no auth, so any network producer is trusted by today's consumers.
6. Public respondents to fORM- `/f/*`. During coexistence they can also go straight to the DMS anonymous routes, **which stay open until P7**.
7. Tenant authors to the outbound fetches fORM- makes for them: webhooks, lookups and API validation, through the egress guard.

**Main adversaries**
- An anonymous internet attacker, who uses public forms, public DMS routes, hand-off links and phishing.
- A malicious or compromised author in tenant A who targets tenant B, or targets DMS users through stored content.
- A low-privilege DMS user who wants confidential records or workspaces they do not belong to.
- An attacker holding a stolen or committed DMS JWT.
- A network-adjacent attacker in the VPC, through MSK or internal HTTP.
- A compromised fORM- pod. The ADR's service-to-service design makes this a high-value pivot into DMS and Flow+.

**Overall verdict.** The architecture is sound in its main choices:
- DMS stays the system of record.
- All writes go through path B.
- No fORM- Kafka producer.
- An exchange instead of shared cookies.
- Verify-by-read for inbound hints.

It is **not** safe to launch as written. Six issues block it:
1. The exchange has no binding to the browser that started it, so login CSRF and cookie tossing work.
2. The workspace and classification checks rely on DMS controls that do not exist.
3. fORM- slugs are global, which lets a tenant squat another tenant's slug.
4. The codec writes back JSON that Form+ renders as raw HTML on the DMS origin, which is stored XSS.
5. The fORM- service token for Flow+ is effectively "approve as anyone".
6. fORM-'s anti-abuse is bypassable for as long as the DMS anonymous routes stay open. The ADR leaves them open until P5/P7.

---

## 2. Findings

Severity scale: **C** critical, **H** high, **M** medium, **L** low.

| ID | Sev | Component | Issue | Evidence | Required control |
|---|---|---|---|---|---|
| S1 | C | Identity: gateway hand-off and exchange (§4.4 F1, §5.2) | **The hand-off code is not bound to the browser that started the flow.** An attacker gets a code for their own DMS identity and sends the victim a `forms.<domain>/dms/...?code=` link. The victim is then signed into the attacker's fORM- session (login CSRF) and types data into it. A second route: an attacker with XSS or a takeover on any `*.<domain>` writes their own `token` cookie for `.<domain>`. The gateway then mints codes for the attacker in the victim's browser. | `domain=.<DISPATCH_DOMAIN>` with no HttpOnly (auth-frontend:src/components/Cookies/setCookie.tsx:1-12). The ADR binds the code to {tenant, sub, target, payload digest} only. | Make it OAuth-style. `forms.<domain>` starts the flow: it sets a `__Host-fr_hs` state and PKCE-verifier cookie, then redirects to the gateway with `state` and `code_challenge`. The gateway returns the code to an exact registered `redirect_uri`. The exchange checks the state cookie and the PKCE verifier. Before minting, show "Continue as <name>, <tenant>?". Reject codes not redeemed by the browser that started the flow. |
| S2 | C | Tenancy: workspace = team (§5.3) | **Workspace membership is never proven.** `verify.workspace` only checks that the header is present. If fORM- fills `app_teams()` from header-supplied or request-supplied workspaces, or relies on DMS rejecting a wrong `X-Workspace-Id`, any tenant member can reach every workspace's forms and records. | dms-api:app/Http/Middleware/VerifyWorkspace.php:20-30 (dossier). Form list, `show` and `by-slug` have no workspace filter (dms-api:app/Repositories/FormBuilderRepository.php:63-105, 327-339). | Take the workspace list only from an authoritative server-side source: auth-api `user_product`, the authz snapshot, or a new DMS endpoint. Never take it from headers, the path or the ticket alone. fORM- must enforce team RLS itself and always send `dms_workspace_id` from the link row. Add a cross-workspace isolation test to `isolation.int.test.ts`. |
| S3 | C | Record reads: embed view and record edit (§10.3, F6, §5.4) | **"DMS RBAC remains the authority" is false for record reads.** Classification and folder RBAC does not apply to `master-records/show`, `form/{master}/list` or `workflow/master-records-list`. `form/slug/{name}/find/{id}` only matches the workspace. The anonymous `form-by-slug/{name}/find/{id}` returns any record by UUID. The read-only embed and the edit prefill would show confidential records to any workspace member, or to anyone with a ticket. | dms-dossier §7 (MasterPolicy.php:30-80 viewAnyNew is not applied to records); dms-api:routes/api.php:600 (public find); FormController.php:222 | fORM- must apply master classification against the user's access right (the Full, Restricted or Public matrix) before it reads or renders a record. Fail closed while that data cannot be fetched. Never call the public `form-by-slug/*/find` route. Escalate to DMS (E3). The embed and edit features are blocked until either DMS enforces classification on record reads or fORM- does. |
| S4 | H | Public fill: global fORM- slugs (§4.4 F4, §9.1) | **Cross-tenant slug squatting.** `form_slugs.slug` is the primary key across all orgs, while DMS slugs are only unique per tenant. If the gateway hands `/formbuilder/{t}/{slug}` to `/f/{slug}`, or the import keeps DMS slugs, tenant A can claim a slug before tenant B's master is imported. B's DMS links then open A's form, which captures B's respondents' data (phishing inside a trusted host). | fORM- dossier §9 (global `form_slugs`); the ADR maps to `/f/{slug}` | The gateway must hand off by `(org_id, form_id)` from `dms_form_links`, e.g. `/f/id/{formId}` or a signed short link. Never resolve a DMS-origin slug through the global slug table. Give imported forms namespaced or random fORM- slugs, and reserve them on import. |
| S5 | H | Codec export, read by legacy Form+ (§4.4 F3, §9.4 rollback) | **Stored XSS on the DMS origin.** Form+ renders labels, help, rich text, `closed_text` and text blocks with unsanitised `v-html`, and injects `custom_code` into `<head>`. fORM- writes `form_builders.json_data`, and Form+ renders exactly that JSON on rollback or for proxied routes. Any author-controlled HTML runs on `dms.<domain>`, where it can steal every viewer's JS-readable 1-year `token`. Imported JSON may already hold such HTML. | FB:OpenFormField.vue:46,53; OpenCompleteForm.vue:73,84; FB:pages/[tenantId]/[slug]/index.vue:249-259 (custom_code); FB dossier §10.6 | The codec export emits only allowlisted, sanitised HTML in `rich_text` (DOMPurify-equivalent, no attributes except href/https) and plain text everywhere else. Never export `custom_code`, `seo_meta` or `closed_text` HTML. On import, sanitise and drop `custom_code`. Add a codec test that fails when `<script`, `on*=` or `javascript:` survives the round trip. Ask DMS to sanitise as well (E8). |
| S6 | H | Flow+: service-caller step action (§6.5, §10.1, D6) | **`serviceCallerAuthorized:true` plus one shared token means one fORM- credential can approve any step in any tenant as any assignee**, and push `fieldUpdates` into the lock-exempt, event-free `metadata.update` path. A compromised fORM- pod forges approvals. `WORKFLOW_INTERNAL_SERVICE_TOKENS` also unlocks **every** `/internal/` path, including break-glass `resolve-node` and authz invalidate. | monorepo:…/serviceTokenAuth.ts:24-27,109-115 (regex `/internal/`); workflowStepActionActor.ts:15-55; WorkflowKafkaConsumer.php:329-333 (`update(...,false)`) | workflow-api must accept a fORM- completion only when it echoes an **outstanding launch-ticket `jti` that workflow-api minted** for that (tenant, run, step, user), with the step still waiting. Burn the jti in workflow-api. Scope fORM-'s token to that single route. Pin the allowed `fieldUpdates` field ids to the node's `outputMapping` at workflow publish time and enforce that in workflow-api. Validate values with the DMS field rules, either before staging or in the consumer. |
| S7 | H | Anti-abuse during coexistence (§2.10, D9, §13) | **fORM- captcha, validation and limits can be bypassed.** For migrated masters, `createSubmission` (anonymous, unthrottled, no validation), `master-records-by-slug`, `multiple-document-upload-new` (impersonation via the body `user_id`) and storage-api `*-new` all stay open until P5 or P7. An attacker skips fORM- and writes straight to DMS. Worse, P3-P4 public projection itself depends on the public `master-records-by-slug` route, so the bypass is built into the design. | Verified routes listed above; DocumentController.php:1189-1196 | Move D9 (410 for `form_engine='form'` masters on `createSubmission`, public `find` and `multiple-document-upload-new`) and D1-D3 **before any tenant reaches `fill`**. That gives up "zero DMS change for the pilot", but only for an internal pilot without real public traffic. Until then, put a WAF rule on the ALB that blocks those paths except from fORM- egress IPs for flagged tenants. |
| S8 | H | Token lifetime and the committed JWT (§5.1-5.2) | **The exchange accepts any unexpired Passport token.** The committed fallback JWT (still valid; the dossier says exp April 2027) and any token stolen via XSS (cookie readable, `.<domain>`) become fORM- sessions, and re-check every 15 minutes with the same token. There is no `jti` revocation list in fORM-. | Committed JWT at the two interceptor paths (verified, value redacted); dossier platform §1.1 (365 d, no revocation) | Before launch: DMS revokes that token's user/jti and removes the fallback (E1). fORM- adds a denylist by `jti`/`sub` and a cap on `iat` age for the exchange (for example, reject tokens issued more than 24 h ago unless confirmed against a live DMS session endpoint). Bind fORM- sessions to the DMS identity, and end all sessions on any revocation hint. Make the request for short-lived tokens, refresh and revocation (O12) a **GA blocker**, not "non-blocking". |
| S9 | H | Sealed DMS JWTs in fORM- (§5.2 step 6, P1-P4) | fORM- would cache every pilot user's **1-year bearer token**. Any role that can decrypt them can call dms-api as any of those users, with full DMS authority beyond forms. dms-api also logs raw tokens on error, so forwarding expired sealed tokens writes them into DMS logs. | VerifyToken.php error logging (verified) | Limit the internal pilot to staff accounts. Allow decryption only in the `fr-api` request path and `fr-worker-dms`, through separate KMS key grants. Never use the token after the fORM- session ends (TTL = min(session, 12 h)) and never retry with an expired one. Delete on logout or revocation. Audit every unseal. Bring D1+D3 forward so this goes away before the first external tenant. |
| S10 | H | DMS JWT cookie sent to fORM- (O10, §11.5) | `forms.<domain>` is a subdomain, so browsers attach the DMS `token` cookie (and `userObject`) to **every** fORM- request. Access logs, OTLP spans, error reporters and request dumps at the ALB, WAF, ingress or Fastify would collect bearer tokens. | setCookie domain scope (verified) | Strip DMS cookies at the ingress for `forms.<domain>` (ALB/ingress header rewrite), except on the one exchange route if it needs them. Add Fastify and pino redaction for the `cookie` header. Prefer a separate registrable domain for fORM- (for example `dmacqforms.com`): it also removes cookie tossing and the same-site CSRF surface. If it stays a subdomain, `corsOrigins` must not list any DMS origin for credentialed routes. |
| S11 | H | Hand-off payload: forged prefill (§4.4 F1.3) | "Values are sent as the user" is a confused-deputy pattern. A forged `payload` (the SHA-256 has no key) pre-selects `classification:"public"`, attacker-chosen `folder_ids`/`doctype_ids` and the master name. An admin who clicks through publishes it. Linking a confidential folder to a public master can leak documents through master listings. | FB:lib/hashData.js:25-39; dms-ui utils/hashData.ts:6-33 | Treat every value in `payload` as untrusted display data. Drop classification, folders and doctypes from prefill, or show them unselected so the user must actively confirm each security-relevant field. Re-fetch the options from DMS. Fetch `returnUrl`/`redirect_url` through URL parsing with **exact origin equality** against `https://dms.<domain>` and a path prefix check, not a string regex. Make D7 (a signed hand-off) a P5 item, not P7. |
| S12 | M | Embed and launch tickets in the URL (§7, §10.1-10.3) | `?ticket=` and `?code=` in query strings leak through `Referer`, ALB and access logs, browser history and the dms-ui or workflow-ui telemetry (Amplitude). Tickets give a record view or step completion. | ADR §7 table | Deliver tickets in the URL fragment, or by `postMessage` to an exact origin, then swap them for an in-memory header token. Make them single use. Send `Referrer-Policy: no-referrer` on landing pages. Strip the code from history with `history.replaceState`. Bind each ticket to (tenant, user, record or step, audience). TTL is 2 min or less for codes and 5 min or less for tickets. |
| S13 | M | Egress allowlist widens SSRF (§11.4) | `EGRESS_POLICY=allowlist` with dms-api, storage-api and workflow-api hosts. The ADR does not say *which* guard gets the list. If the tenant guard gets it, any author with `data.route` can aim webhooks, and later the server-side lookups or API validation, at internal DMS services. The allowlist branch does not restrict private ranges. Internal dms-api routes resolve the tenant from `Referer`/`X-Workspace-Id`, so cross-tenant writes become plausible. | fORM-:packages/adapters/src/egress/guard.ts:110-148 (dossier) | Put DMS and Flow+ hosts **only** in the infrastructure guard used by `fr-worker-dms` and `fr-worker-flow`. The tenant guard stays `open` (public addresses only), with DMS hostnames and the VPC CIDRs on an explicit denylist. Never let tenant-configured URLs or headers reach the infrastructure guard. Add a test that a webhook to a dms-api host is refused. |
| S14 | M | Runtime credential leak (P0 WP2) | The browser receives author credentials (`ApiAuth` bearer, API key and basic password) from `apiOptions`/`validation.api`. There is no server-side re-check. dev-lokesh `lookups` repeats the pattern. | projectForRuntime.ts:32-40 (verified); envelope.ts:71-90 | This is a launch gate (already WP2). The fetch moves to the server through the **tenant** egress guard. Credentials become `secrets` references. Add a projection test that fails if any block or lookup carries `auth`. The submit path re-validates server-side. |
| S15 | M | PII and data residency (§4.3, O2) | The journal stores plaintext answers (`ANSWER_CODEC_PLAIN`) for 30 or more days, plus files in fORM-'s S3 staging, in **one shared region**. DMS tenants have per-tenant storage (S3 or Azure in their region, SFTP, local). fORM- funnels every tenant's PII through one region and bypasses the tenant's chosen storage. Also, the delivery plan says "do not use with real personal data". | fORM- arch :545-551; storage-api per-tenant `storage_settings` (dossier §3) | Before any real tenant reaches `fill`: WP-1.11 field encryption (per-org keys), WP-1.14 S3 plus ClamAV, and a per-org region pin (`orgs.region` enforced for buckets and RDS) or a written residency acceptance per tenant. Keep the journal to a digest and ids by default (answers only while `pending`/`failed`), and redact at `done` + 7 days rather than 30. Run a DPIA under DPDP. |
| S16 | M | File projection: identity and folder (F8) | P3-P4 use the impersonation route with `user_id` = form owner. If `folder_id` or `master_id` come from the fORM- definition or the hand-off payload, a malicious author files public uploads as the owner into any folder in the tenant. | FB:lib/file-uploads.js:248-285; DocumentController.php:1189-1196 | Read `folder_id` only from DMS (`v1/master/form/{id}` / `masters-form-builders`) at projection time. Never take it from the definition. Re-check that the owner is still active and allowed to create documents. In P5, DMS must allowlist the presigned pull target to the exact fORM- bucket host: HTTPS only, no redirects, size cap, content-type check. |
| S17 | M | Import job authority (§9.1 `dms.import.forms`) | The import lists forms through `GET form?source=` (not workspace-filtered) using some user's token. If an admin's token is used, confidential masters' definitions from every workspace land in the fORM- org without correct team assignment. | FormBuilderRepository.php:63-105 | Import per workspace with the right `dms_workspace_id`, and per master read `classification` and folder mapping. Assign `team_id` from DMS data, never by default. Hold confidential masters until an admin allows them. Use the P5 app token (scoped `forms.master.read`) instead of a sealed admin JWT. |
| S18 | M | Service tokens shared across callees (§5.5) | dms-api `workflow.service.token` and workflow-api `serviceTokenAuth` read the **same env var name**. A fORM- token issued for the dms-api authz snapshot would, if the values are reused, also open all workflow-api `/internal/` routes. The authz snapshot returns any user's roles for whatever `X-Tenant-Id` is sent. | dms-api config/workflow.php:16-18; serviceTokenAuth.ts:24-27 | Use a distinct secret per (caller, callee), with route scoping and rotation. Send the tenant only from `org_dms_links`. Escalate the env-name collision (E6). Prefer the app-token table with sha256 storage (D3) for every fORM- to dms-api call. |
| S19 | M | Gateway as a shared component (§4.2) | It sits on the DMS origin and handles every legacy request. Risks: it becomes an open proxy, it forwards spoofable `X-Forwarded-*` or `X-Custom-Referer` (DMS uses that for tenant resolution, and trusts it when the referer contains `localhost`), and its decision cache is poisoned by unauthenticated input. | InitializeTenantDatabase.php:143-191 (verified localhost branch) | Fix the upstreams (Form+ target group and fORM- only). Strip inbound `X-Forwarded-*`, `X-Custom-Referer` and `X-Tenant-Id` before proxying, or pass them through untouched exactly as today and never add trust. Key the decision cache on tenant id only. The gateway holds no secrets except the Passport public key and its service credential. NetworkPolicy keeps the routing endpoint cluster-only (as the ADR says). Alert on `localhost` referers reaching dms-api in prod. |
| S20 | M | Platform control of routing (`PUT /v1/internal/dms/routing`) | The ADR uses a `platform` actor with MFA, but `fr_platform` and the platform surface are **not built**. `tenant_routing` and `dms_slug_history` are global tables with definer reads. | fORM- dossier §3 | Build the platform actor (WP) before P1, or limit changes to a CLI with audited DB role access. Each definer function returns only `(stage, write_path)` for one tenant. Audit every change on the platform chain. |
| S21 | M | Kafka inbox (§6.3) | MSK has no auth. Verify-by-read is right, but `dms.user.delete`/`update` hints that **end sessions** can be used by anyone on the network to cause mass logout (DoS). Re-reads on each hint also amplify load on DMS. | kafkaClientConfig.ts:13 (dossier) | Rate-limit hint handling per tenant. Collapse duplicate re-checks (singletonKey). Treat revocation as "re-check now", which the ADR already does; never revoke without a confirming DMS read. Keep the consumer read-only, with no producer ACL, once MSK gets auth. |
| S22 | M | Record edit and prefill on public paths (F4, F6) | Form+ honours `submission_id` in master mode and prefills through public `find`. If `/f/*` or `/dms/{t}/{slug}?submission_id=` prefills without a session plus an authorisation check, it is a record IDOR. | FB:OpenForm.vue:549-562; routes/api.php:600 | Allow `submission_id` only on authenticated `/dms/...` routes. Read through the user-scoped DMS route plus the S3 classification check. Ignore `submission_id` on public routes, and test that. |
| S23 | L | `postMessage` and embed framing (§7) | `frame-ancestors https://dms.<domain>` trusts an origin that still hosts Form+ (XSS-prone, S5) and several SPAs. | FB:OpenCompleteForm.vue:558-561 | Accept this, but use explicit `targetOrigin` and check `event.origin` on receipt (planned). Only non-sensitive status goes in messages, never answers. |
| S24 | L | Licence (AGPL) | Form+ is very likely AGPL-3.0-derived and has no LICENSE file. It is served to network users today, which is likely §13 non-compliance now. The gateway keeps serving it until P7. The package name `@form/compat-opnform` uses the upstream mark. workflow-api carries an MIT "Dentsu SaaS" licence (provenance). | FB:opnform.config.js:9-10; FB:app.vue:37; monorepo:apps/backend/workflow-api/LICENSE | Get a counsel memo **now**, not at P7, covering the interim. Options: publish Form+ source under AGPL, or accelerate retirement. Run a clean-room process: codec authors work from the JSON spec and the dossier, not from OpnForm source, and keep a record of that. Rename the package (e.g. `@form/compat-formplus`). Do a provenance review of workflow-api. |
| S25 | L | Pre-D2 idempotency gap (F5) | Without D2, replays of ambiguous timeouts create duplicate records, which can trigger duplicate workflows and approvals. | ADR §4.4 F5 | Already reduced by sending ambiguous timeouts to `needs_attention`. Keep D2 as a gate for external tenants. |
| S26 | L | storage-api `GET /media/storage` | Unauthenticated endpoint that runs a shell `df` and returns filesystem details. | storage-api:routes/api.php:~20-22 (verified) | Escalate to DMS (E7). Remove it or require auth. |

---

## 3. Required changes to the ADR

1. **§4.4 F1 and §5.2 (S1).** Replace "gateway mints code → 302" with a flow that starts on the forms host: `__Host-fr_hs` state cookie plus PKCE, an exact `redirect_uri`, a confirmation screen, and a code TTL of 60 s or less. Add: "Codes redeemed without a matching state cookie are refused and audited."
2. **§5.3 (S2).** Replace "teams (the user's workspaces)" with "workspaces from <named authoritative DMS source>, never from headers". Add a team RLS policy on `forms`, `submissions` and `dms_*` tables, and add cross-workspace tests to the isolation suite.
3. **§5.4 and §10.3 (S3).** Remove "DMS RBAC remains the authority" for reads. Add "fORM- enforces master classification against the user's access right before any record read or render; fail closed". Block WP21 (embed) and WP14 (record read/edit) on this or on E3.
4. **§4.4 F4 and §9.1 (S4).** The hand-off target is form-id based. Imported forms get fresh fORM- slugs. Add "DMS slugs are never looked up in the global `form_slugs`".
5. **§4.4 F3 and §9.1 codec (S5).** Add an "Export sanitisation" rule (sanitised rich text, plain text elsewhere, no `custom_code`, `seo_meta` or HTML `closed_text`). Sanitise on import. Add an XSS round-trip test as a fourth parity gate.
6. **§6.5, §10.1 and D6 (S6).** Completion must echo the launch-ticket `jti`, which workflow-api checks and burns. Scope the token to one route. `outputMapping` is pinned at publish and enforced in workflow-api. Add a value validation step for `fieldUpdates`. Remove "fORM- computes the outcome" as an unverified trust: workflow-api accepts only labels declared in the node's outcomes.
7. **§2.10, §12 D9 and §13 (S7).** Move D9 (410 for migrated masters) and D1-D3 to "before the first non-internal tenant reaches `fill`". Add a WAF rule as the interim control. Reword "P1-P4 need no DMS code changes" to "P1-P2".
8. **§5.1-5.2 (S8).** Add a `jti`/`sub` denylist and a max token age at exchange. Add a pre-launch gate that the committed token is revoked. Change O12 to "GA blocker".
9. **§5.2 step 6 (S9).** Sealed-token use is limited to internal staff tenants. TTL = min(session, 12 h). Separate KMS grants. Audit every unseal. Never forward an expired token.
10. **§11.4 and O10 (S10, S13).** Strip DMS cookies at the ingress for the forms host. Redact the `cookie` header in logs and traces. Recommend a separate registrable domain. DMS and Flow+ hosts go only in the infrastructure egress guard. The tenant guard stays `open`, with a DMS and VPC denylist.
11. **§4.4 F1.3 (S11).** Prefilled security-relevant fields (classification, folders, doctypes) require explicit confirmation. Redirects are checked by URL-parsed exact origin. D7 moves to P5.
12. **§7 (S12).** Tickets and codes go in the fragment or through `postMessage`. Add `Referrer-Policy: no-referrer`, single use and audience binding.
13. **§4.3 and O2 (S15).** Journal defaults to digest-only after `done`, with answers redacted at 7 days. WP-1.11, WP-1.14 and the region pin become gates before **any** real-data tenant, not "before broad rollout". Add a DPIA.
14. **§4.4 F8 (S16).** `folder_id`/`master_id` for documents come from DMS at projection time. DMS-side pull rules: exact host, no redirects, size cap.
15. **§6.2 and §9.1 (S17).** Import runs per workspace and is classification-aware, using the app token, not a sealed admin JWT.
16. **§5.5 (S18).** One secret per (caller, callee) with route scope. Add a note on the shared env-name hazard.
17. **§4.2 gateway (S19).** Add the header rules (strip `X-Custom-Referer`, `X-Forwarded-*`, `X-Tenant-Id` on hand-off; fixed upstreams; never an open proxy).
18. **§7 and §13 (S20).** Add a work package to build the platform actor, or a CLI-only control, before P1.
19. **§14 risk table.** Add rows for S1, S3, S4, S5 and S6. Licence row (S24): "counsel memo before P1, not P7".
20. **§2.5.** Add: "fORM- sessions created via exchange are revoked whenever the source DMS user is disabled, `status=7`, or removed from the tenant. VerifyToken does not check status, so fORM- reads it explicitly." (Status checking in VerifyToken was not verified; treat it as absent.)

---

## 4. Pre-launch security gates

**Before P1 (gateway pass-through)**
- [ ] The gateway strips or does not add trusted forwarding headers, has fixed upstreams, keeps the routing endpoint cluster-only, and has a break-glass ALB rule staged.
- [ ] Platform or CLI control for `tenant_routing` exists, with audit (S20).
- [ ] Counsel memo on AGPL exposure of Form+ during coexistence (S24).
- [ ] fORM- `dev` is backed up to a private remote (owner decision).

**Before P2 (identity and shadow import)**
- [ ] The exchange uses state cookie plus PKCE, a confirmation screen and single-use codes. Tests cover login CSRF and cookie tossing (S1).
- [ ] RS256 is pinned; `aud` is pinned; HS* is refused, with a test. Tokens are never logged.
- [ ] The committed fallback JWT is revoked and removed. fORM- denylists its `jti`/`sub` (S8, E1).
- [ ] Workspace membership comes from an authoritative source. Team RLS is in place, with cross-workspace isolation tests (S2).
- [ ] Ingress strips the DMS cookie on the forms host. The `cookie` header is redacted in logs and traces (S10).
- [ ] Import sanitises HTML and drops `custom_code`. Imports are per workspace and classification-aware (S5, S17).

**Before any tenant reaches `editor`**
- [ ] Codec export sanitisation with XSS round-trip tests (S5).
- [ ] Hand-off prefill hardening: security fields need confirmation; redirect checked by exact origin (S11).

**Before any tenant reaches `fill` with real data**
- [ ] `projectForRuntime` credential strip. Server-side lookups and API validation go through the tenant egress guard (S14).
- [ ] Captcha or PoW live on `/f/*` (WP-1.13).
- [ ] DMS anonymous routes return 410 for migrated masters (D9), or a WAF block is in place (S7).
- [ ] D1-D3 (app token with sha256, idempotency) are live for any external tenant. Sealed tokens are limited to internal staff tenants (S9).
- [ ] WP-1.11 field encryption, WP-1.14 S3 plus ClamAV, a region pin or written residency acceptance, and a DPIA (S15).
- [ ] Global slugs are never used for DMS hand-off (S4).
- [ ] File projection reads `folder_id` from DMS (S16).
- [ ] `submission_id` is ignored on public routes, with a test (S22).
- [ ] Egress: DMS hosts are in the infrastructure guard only. A webhook to a dms-api host is refused (S13).
- [ ] A classification check exists before any record read or render (S3).

**Before P6 (Flow+ and embed)**
- [ ] workflow-api validates and burns the launch-ticket `jti` on completion. The token is scoped to one route. `outputMapping` is pinned and enforced in workflow-api (S6).
- [ ] Tickets go in the fragment or through `postMessage`, single use, with `no-referrer` (S12).
- [ ] Distinct service secrets per (caller, callee) (S18).

**Before GA / P7**
- [ ] DMS identity hardening: JWKS with `kid`, short TTL, refresh and revocation (S8).
- [ ] Anonymous DMS form, upload and storage routes closed. Form+ retired.
- [ ] Adversarial security retest of the built system, with each finding proved by a script or test, run by Fable if the founder approves it, otherwise Opus.

---

## 5. Escalate to the DMS team now

| # | Item | Evidence | Why now |
|---|---|---|---|
| E1 | **Revoke and rotate the committed Passport JWT** and remove the fallback `Authorization` header. | monorepo:apps/frontend/dms-ui/lib/interceptors/dms.interceptor.ts:60; apps/frontend/workflow-ui/lib/interceptors/dms.interceptor.ts:50 (verified; value not printed) | It is a live bearer token valid until about April 2027 that sits in the client bundles and git history. It works against every DMS API today. |
| E2 | **Anonymous write routes:** `createSubmission` (no throttle, no IP whitelist, no validation); `multiple-document-upload-new` and `multi-uncat-upload-new` (`User::find($request->user_id); auth()->login()`, which logs in as any user); storage-api `upload-chunk-new`, `complete-upload-new` and `final-document-upload-new` (`X-User-Id` trusted). | dms-api:routes/api.php:575-580, 588-589; DocumentController.php:1189-1196; storage-api:routes/api.php:14-19 (all verified) | Exploitable today without fORM-. The ADR also relies on them being closed for fORM- anti-abuse to mean anything (S7). Ask for D9 and D1-D3 now. |
| E3 | **Record reads skip classification and folder RBAC.** The public `form-by-slug/{name}/find/{id}` returns any record by UUID. | dms-api:routes/api.php:600; dossier §7 | Exists today, and blocks the fORM- embed and edit features (S3). |
| E4 | **Tenant from client input:** `X-Tenant-Id`, `?tenant_id`, Referer, `X-Custom-Referer` (trusted when the referer contains `localhost`), `X-Workspace-Id`. `verify.workspace` checks presence only. | InitializeTenantDatabase.php:143-191 (verified); VerifyWorkspace.php:20-30 | Combined with E2 it enables cross-tenant writes. Ask DMS to bind the tenant to the token or the `user_product` row on authenticated routes, and to drop the Referer and `localhost` fallbacks in prod. |
| E5 | **VerifyToken logs raw JWTs on failure** (expired, bad signature, unexpected error). | dms-api:app/Http/Middleware/VerifyToken.php:~106-114 (verified) | Log stores hold 1-year bearer tokens. Ask for redaction and a rotation review of log access. |
| E6 | **Service-auth hygiene:** app tokens stored and compared in plaintext (verified at AppTokenAuth). dms-api and workflow-api share the `WORKFLOW_INTERNAL_SERVICE_TOKEN(S)` name, and the workflow-api token opens every `/internal/` path. workflow-api also accepts HS256 via the shared `JWT_SECRET` and merges client `x-user-roles` unless `WORKFLOW_AUTHZ_REQUIRE_REDIS` is set. | AppTokenAuth.php (verified); serviceTokenAuth.ts:24-27; AuthorizationMiddleware.ts:130-262, 468-475 (dossier) | These are prerequisites for D3 and D6. Confirm the prod value of `WORKFLOW_AUTHZ_REQUIRE_REDIS`. |
| E7 | **Other unauthenticated or over-exposed surfaces:** storage-api `GET /media/storage` (shell `df`, verified); auth-api unauthenticated S3 presign and download of arbitrary keys (`routes/api.php:19-37,53-88`); `GET /api/migrate-tenant` at ROOT; iam-api HTTP has no auth; dms-realtime accepts unverified JWTs and falls back to tenant `"default"`; the websocket service `io.emit` broadcasts to all tenants. | dossier platform §8, touchpoints §2.6 | Each one is a tenant-data exposure independent of fORM-. fORM- must not publish to realtime or websocket until they are fixed. |
| E8 | **Form+ stored XSS sinks on the DMS origin** (unsanitised `v-html`, `custom_code` head injection, `postMessage("*")` with submission data, `NODE_TLS_REJECT_UNAUTHORIZED=0` in the image). With JS-readable `.<domain>` cookies this leads to token theft. | FB:OpenFormField.vue:46,53; index.vue:249-259; OpenCompleteForm.vue:558-561; Dockerfile:24 (dossier) | Exists today. Ask for HttpOnly, Secure and SameSite=Lax on the `token` cookie (or a move to a BFF), a CSP on the DMS origin, and sanitisation in Form+ until it is retired. |
| E9 | **MSK PLAINTEXT with no auth.** Anyone on the network can inject `dms.masterrecord.metadata.update` (writes to tenant DBs, lock-exempt) and `workflow-trigger-*`. | kafkaClientConfig.ts:13; WorkflowKafkaConsumer.php:254-334 (dossier) | Writes to any tenant's records today. Ask for SASL/SCRAM or IAM auth plus topic ACLs. |
| E10 | **Confirm which `outbox:publish` is live in prod** (dms-api schedule commented out, auth-api runs a different envelope). | dms-api routes/console.php:45-46; auth-api routes/console.php:12 | Without it, the "path B fires Flow+ triggers" assumption may be false (also integrity: triggers that silently do not fire). |
| E11 | **Licence:** Form+ ships with no LICENSE and is likely AGPL-derived (`opnform.config.js`, `app.vue:37`), and it is network-served today. | FB:opnform.config.js:9-10; FB:app.vue:37 | Legal exposure exists now. Counsel should decide on interim compliance (publish source) versus accelerated retirement. |

Secrets seen, reported as path and kind only:
- The committed Passport JWT (E1).
- auth-frontend:src/modules/auth/components/identity/index.tsx:390,398,402: hard-coded CryptoJS-encrypted product `sub` blobs. The decryption key is a `NEXT_PUBLIC_*` value in the client bundle.
- auth-frontend:src/modules/auth/components/Amplitude.tsx:13,66,125: client analytics key. Low.
- fORM- `dev-lokesh`:deploy/docker/compose.prod.yaml:13,30,33: a weak literal default for `AUTH_SECRET` and database password literals. Do not deploy it. It is not on `dev`.
