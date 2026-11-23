# ADR-0023: Integrating fORM- with DMS+ and replacing Form+

- **Status:** Proposed
- **Date:** 2026-11-23
- **Deciders:** CTO, fORM- lead, DMS+ platform lead, Flow+ lead
- **Supersedes:** none. **Related:** ADR-0007 (pg-boss outbox), ADR-0008 (CSRF), ADR-0016 (signed job envelopes), ADR-0017 (sessions), ADR-0018 (BYO storage)

> **Citation key.** `FB:` = dmacq-form-builder, `dms-api:` = dmacq-dms-workflow-dms-api, `auth-api:` = dmacq-dms-workflow-auth-api, `storage-api:` = dmacq-dms-workflow-storage-api, `monorepo:` = dmacq-dms-workflow-monorepo, `auth-fe:` = dmacq-auth-frontend, `reports-api:` = dmacq-dms-reports-api, `realtime:` = dmacq-dms-realtime, `fORM-:` = this repo on `dev`. DMS repos were read at origin/dev (dms-api 53d1fb2bb, monorepo 0e494aa2, form-builder ebc4737). Anything marked **VERIFY** has not been confirmed and must be checked before building on it.

> **Security amendments (binding; from the security review in [0023a](0023a-dmsplus-integration-security-review.md)).**
> The body below predates the review. Where they conflict, the review's §3 "Required changes" win. The ones that change the design:
> - **S1** Hand-off starts on the forms host: `__Host-fr_hs` state cookie + PKCE, exact `redirect_uri`, "Continue as …" confirmation.
> - **S2** Workspace membership comes only from an authoritative DMS source, never headers; fORM- enforces team RLS itself.
> - **S3** DMS does not apply classification/folder RBAC to record reads. fORM- must check classification before any read/render (fail closed); the embed and record edit are blocked until it does or DMS fixes it.
> - **S4** Hand-off is by `(org_id, form_id)`, never by DMS slug through the global `form_slugs` table.
> - **S5** Codec export/import sanitises HTML and drops `custom_code`: Form+ renders that JSON with raw `v-html` on the DMS origin.
> - **S6** Flow+ completions must echo a workflow-api-minted launch-ticket `jti`; the fORM- token is scoped to one route; `fieldUpdates` pinned to `outputMapping`.
> - **S7** DMS anonymous routes (D9) and D1-D3 move before the first non-internal tenant reaches `fill` (WAF block as interim).
> - **S8-S10** Exchange caps token age and denylists the committed JWT; sealed tokens only for internal staff; strip DMS cookies at the forms-host ingress (prefer a separate registrable domain).
> - Citations were spot-checked on 23 Nov 2026 (createSubmission middleware, `source='dms'` default, build-time `NEXT_PUBLIC_FORM_BUILDER_URL`, unconditional `required`); two line references were corrected.

---

## 1. Context

**Form+ is a client-only shell over dms-api.** Form+ (`dmacq-form-builder`) is a Nuxt 3 fork of OpnForm's client. Its facts:

- It has no backend: `server/` is empty (FB:server/tsconfig.json:1-3).
- It serves `/formbuilder/{tenant}/create|{slug}|{slug}/edit` (FB:nuxt.config.ts:13-15).
- It calls dms-api `/api/dms/form*`, `/api/dms/v1/master/form`, `/api/dms/submissions/{master}/createSubmission`, and the storage-api `-new` chunk routes.
- In DMS terms, a Form+ "form" is a **master**: `masters`, `master_fields`, `form_builders.json_data` holding OpenForm-style JSON, and a per-master MySQL table `_dynamic_master_<uuid>` (dms-api:app/Services/FormService.php:73-217).
- A submission is a **row in that dynamic table**. It is not a JSON blob.
- The repo has no LICENSE file and is very likely AGPL-3.0-derived (FB:opnform.config.js:9-10, FB:app.vue:37).

**What DMS actually exchanges with Form+ is small.** DMS uses three things and nothing else:

1. **URLs** that dms-ui and dms-api build: `/formbuilder/{tenant}/…`, `?utm_source=master&submission_id=…&payload&hash&redirect_url` (monorepo:apps/frontend/dms-ui/features/metadata/components/MasterFormUI.tsx:779-839; MasterDetailView.tsx:658-686,949-983; dms-api:app/Services/MasterService.php:1918-1940).
2. **Rows** that Form+ causes dms-api to write: masters, fields, `form_builders.json_data`, and records.
3. **Documents** registered against a record id (dms-api:routes/api.php:589).

**Form+ submissions skip DMS's own record pipeline.** `createSubmission` ("path A", dms-api:routes/api.php:575-580) is anonymous and does none of the following:

- validation
- outbox event
- immediate Elasticsearch index
- central audit
- workflow lock

(dms-api:app/Repositories/FormSubmissionRepository.php:48-117)

Everything else in DMS goes through `MasterRecordService` ("path B"), which does all five (dms-api:app/Services/MasterRecordService.php:1333,1432,1526; app/Services/OutboxEmitterForWorkflow.php:27-124). Flow+ only starts runs from `dms.masterrecord.*` events that path B emits, and only for masters that have a `master_workflow_events` row.

**fORM- is the replacement.** It is Node 24 / Fastify 5 / Postgres 18 with forced RLS per `org_id`, pg-boss transactional outbox, schema v2 and immutable versions. Its current state:

- **Missing for production:** S3 uploads (local `.data/files`, fORM-:apps/api/src/files.ts:8), field encryption (`ANSWER_CODEC_PLAIN`, fORM-:docs/platform/03-architecture.md:545-551), captcha wiring, Docker/Helm, and any external-identity path (fORM-:apps/api/src/auth.ts:121-144).
- **Credential leak:** the runtime projection leaks `apiOptions` and `validation.api` credentials to browsers (fORM-:packages/logic/src/projectForRuntime.ts:32-64).
- **Backup risk:** the platform line exists only on local `dev`/`main`. No remote contains `bbe733ff`.
- **dev-lokesh:** this branch carries unauthenticated publish, by-form read/write and SSRF paths (fORM- dossier §15.2). It must not be merged.

**Constraints:**

- fORM- stays its own service and codebase.
- Every change is additive and flag-gated per tenant.
- Existing master records, search, audit, reports and Flow+ triggers must keep working.
- DMS team changes must be small and contract-shaped.
- Production is AWS ALB → EKS.
- `/api/forms` is taken.

We judged three proposals:

- **dms-native:** DMS is the system of record, fORM- writes through a new authenticated internal dms-api.
- **form-owned:** fORM- is the system of record, DMS gets a projection.
- **strangler:** a contract-compatible gateway and codec, with DMS as the system of record.

## 2. Decision summary

1. **DMS stays the system of record** for master schemas and master records for every master-bound form ("kind M", which is all of Form+ today). fORM- owns the rich definition (schema v2, versions, presentation), the fill experience, server-side validation, file staging, and a short-lived **evidence journal**. Existing records are **never migrated**.
2. **Spine: strangler.** A stateless **`fr-gateway`** (fORM- codebase) takes over the ALB paths `/formbuilder/*`, `/forms/*` and `/sharemaster*` on the DMS host. Per tenant, per master and per route kind, it either **reverse-proxies to the unchanged Form+** or **hands off** to fORM- on `forms.<domain>`.
   - Day 1 is 100% pass-through.
   - dms-ui needs **no code change** for cutover. `NEXT_PUBLIC_FORM_BUILDER_URL` is build-time and global, so it cannot be switched per tenant anyway (monorepo:infra/docker/nextjs/Dockerfile:97, `ARG NEXT_PUBLIC_FORM_BUILDER_URL`).
3. **Every fORM- record write goes through dms-api path B** (`MasterRecordService`). Path A is never used, except an `A_compat` escape hatch for a pilot tenant that refuses new trigger behaviour. That hatch has a sunset date.
4. **Clean-room two-way OpenForm codec** (`@form/compat-opnform`).
   - It imports `form_builders.json_data` into v2, and exports v2 back by **merging onto the previous JSON**, so DMS-internal keys survive.
   - fORM- block id = DMS field UUID.
   - While a tenant is in coexistence, authoring is limited to a **DMS-compat profile**. That keeps rollback to Form+ lossless at any moment.
5. **Identity bridge, no shared cookies.**
   - fORM- verifies the Passport RS256 JWT (alg and aud pinned) **once**, at exchange time, and proves membership by calling dms-api.
   - It mints its own `__Host-fr_sess` on its own host.
   - **1 DMS tenant = 1 fORM- org.** Each DMS workspace = one fORM- team, enforced through `app_teams()` RLS.
6. **Service principal by phase.**
   - Phase 1 (zero DMS change) forwards the user's JWT, sealed server-side, for user-attributed writes, and uses the public path-B slug route for public writes.
   - GA requires the **DMS internal forms API** (grafted from dms-native): an app-token route group with an idempotency key and authenticated document registration.
7. **Respondents never wait on DMS outages.**
   - Authenticated record create/edit projects **synchronously**, with an 8 s budget, so DMS 422/409 errors show inline.
   - Public submissions project **asynchronously** through a pg-boss job, with per-tenant token buckets, a circuit breaker and fair scheduling across tenants.
8. **fORM- produces no Kafka events in v1.** DMS emits the canonical `dms.masterrecord.*` events because fORM- writes through path B. fORM- may **consume** a few topics into an inbox, as hints only: MSK has no auth, so fORM- re-reads DMS before acting.
9. **Flow+ form task.**
   - Phase 1 reuses the `task` node with `dataCollection.source="form"`, a signed launch ticket, and a new workflow-api `POST /v1/internal/run-steps/:stepId/action` that reuses `submitWorkflowRunStepAction`.
   - Answers stay in fORM-. Write-back to the locked triggering record goes through Flow+'s existing `dms.masterrecord.metadata.update`. Response records can also be written to a separate "response master".
10. **Retiring Form+ is a security win.** After the last tenant is at `full` for 30 days, DMS closes the four anonymous write endpoints (`createSubmission`, `multiple-document-upload-new`, storage-api `*-new`, public `form-by-slug/*/find`). Licence exposure ends with that retirement.

## 3. Scoring

Scores run 1-10, higher is better. "DMS-team effort" scores higher when less effort is needed.

| Criterion | dms-native | form-owned | strangler | Notes |
|---|---|---|---|---|
| Zero-breakage | 8 | 5 | **9** | Strangler proves the routing change alone at 100% proxy, and keeps Form+-renderable JSON. form-owned adds a second system of record plus drift, client-supplied record PKs, and a freeze window per master. |
| Scalability | 7 | **8** | 7 | form-owned decouples respondents from DMS completely. The other two get close with async public projection and a journal. DMS path B is the ceiling for all three. |
| DMS-team effort | 6 | 5 | **9** | Strangler needs zero DMS code in phase 1. dms-native needs about 6 PRs up front. form-owned also needs guards on answer fields, client PKs and import routes. |
| Time-to-first-value | 6 | 4 | **8** | Strangler can run a pilot tenant on existing DMS routes. form-owned needs bulk record import before any value. |
| Long-term cleanliness | **8** | 6 | 6 | dms-native has a clean, authenticated, idempotent contract. Strangler carries the compat profile, sealed JWTs and `A_compat` until it is hardened. form-owned is permanent dual-write. |
| Migration risk | **9** | 4 | **9** | Neither dms-native nor strangler moves records. form-owned imports every record (lossy decode, back-partitions, id remap). |
| **Total** | 44 | 32 | **48** | |

**Winner: strangler (spine).** Grafted onto it:

- **From dms-native:**
  - the authenticated internal dms-api route group with an idempotency table, as the GA hardening;
  - DMS **pulling** files from presigned URLs;
  - the journal TTL;
  - the per-tenant breaker and fairness design;
  - the field codec table;
  - `child_record` vs `writeback` targets for form tasks;
  - the signed dms-ui hand-off as the later cleanup.
- **From form-owned:**
  - inbox verify-by-read;
  - the default partition plus alert;
  - workspace = team;
  - the reconciliation job;
  - the "View response" embed ticket;
  - the optional future `form.submission.*` envelope.

## 4. Architecture

### 4.1 Diagram

```
                    Browser (DMS user / public respondent / Flow+ assignee)
                              |                                  |
                 dms.<domain> |                                  | forms.<domain> (own host; __Host-fr_sess)
      +-----------------------+--------------------+             |
      |                 AWS ALB (+WAF)             |             |
      | /dms-v2/*     -> dms-ui                    |             |
      | /workflow/*   -> workflow-ui               |             |
      | /api/dms/*    -> dms-api                   |             |
      | /formbuilder/*, /forms/*, /sharemaster* ---+--> fr-gateway   (break-glass: rule back to Form+ TG)
      +--------------------------------------------+       |     |
                                                           |     |
                 +-----------------------------------------+     |
                 | fr-gateway (stateless, HPA, fail-open)  |     |
                 |  decide(tenant, kind, master):          |     |
                 |    PROXY   -> Form+ target group (frozen image, until P7)
                 |    HANDOFF -> 302 forms.<domain>/dms/... ?code=<one-time>
                 +-----------------------------------------+     |
                                                                 v
   +----------------------------------------------------------------------------------+
   | fORM- (EKS namespace "form")                                                     |
   |  builder SPA + runtime (/f, /dms, /embed, /flow)   fr-api (Fastify, HPA >= 3)    |
   |    /v1/auth/dms/exchange  /v1/dms/*  /v1/p/*  /v1/internal/*                     |
   |    identity bridge | codec | submit pipeline | DMS client (bulkhead/breaker/TB)  |
   |  Postgres 18 RDS (RLS) + RDS Proxy (txn) + pg-boss (same DB, transactional)      |
   |  fr-worker-dms   : dms.project.record / .files, dms.sync.master, dms.reconcile   |
   |  fr-worker-flow  : flow.step.complete                                            |
   |  fr-worker-effects / fr-worker-system (existing queues)                          |
   |  fr-dms-inbox (optional P5): kafkajs consumer -> dms_inbox -> pg-boss            |
   |  S3 staging + clean buckets, ClamAV                                              |
   +-------+-------------------------------+------------------------------+-----------+
           | user JWT (P1) / X-App-Token   | X-Service-Token + HMAC       | presigned GET (DMS pulls)
           v                               v                              |
   dms-api: v1/master/form, master-records  workflow-api:                  |
   (path B); P5: /api/dms/internal/v1/forms/*  /v1/internal/run-steps/:id/action
     -> tenant MySQL _dynamic_master_*, ES hooks, activity_log, outbox_events <--+
     -> Kafka dms.masterrecord.* --> workflow-api (Temporal) --> dms.masterrecord.metadata.update --> dms-api
   workflow-ui / dms-ui: iframe forms.<domain>/embed/* (read-only view, form task)
```

### 4.2 Components

| Component | Role | Notes |
|---|---|---|
| `fr-gateway` | Owns legacy URLs on the DMS host. Resolves tenant, kind, master and slug, then proxies or hands off. | It is the only fORM- component that reads DMS parent-domain cookies. It reads routing through a cached endpoint (60 s TTL). **Fail-open:** on a lookup error it uses the last decision; with a cold cache it PROXYs. It never trusts `redirect_url` without the allowlist. |
| `fr-api` | Existing API plus new `dms` module: exchange, compat codec, DMS client, publish saga, record read/edit, embed tickets, Flow+ internal routes | Stateless. Requires S3 before multi-pod. |
| `fr-worker-dms` | Projection, file projection, master sync, reconcile | Its own Deployment, so DMS backpressure cannot starve email and webhooks. |
| `fr-worker-flow` | Posts step completions to workflow-api | |
| `fr-dms-inbox` (P5, optional) | Consumes `dms.user.*`, `dms.user.permission.updated`, `dms.master.delete`, `workflow-trigger-done-topic-v2` | Hints only. Verifies by reading DMS. |
| `@form/compat-opnform` | Import, export-merge, value codecs (including legacy decoders) | Clean-room: reimplements the JSON shape and copies no OpnForm source, strings or assets. |
| Legacy Form+ | Unchanged, frozen image behind the gateway | Retired in P7. |

### 4.3 System of record

| Data | Kind M (master-bound, all Form+ today) | Kind S (standalone fORM- form) |
|---|---|---|
| Master, field UUIDs, `field_N` columns | **DMS** | n/a |
| Presentation definition (v2, versions, logic, pages, theme) | **fORM-** | fORM- |
| `form_builders.json_data` | DMS row, **written by fORM-** via the codec. It is the rollback artefact. | n/a |
| Record answers | **DMS** dynamic table via path B | fORM- `submissions` |
| Submission evidence (payload, version, hash, timing) | fORM- journal: full answers until projection `done` + 30 days (configurable per org), then answers redacted, digest/version/ids kept | fORM- (retention policy) |
| File bytes | DMS documents (tenant storage). fORM- holds staging only. | fORM- S3 |
| Search, reports, record audit | DMS (from path B) | fORM- |
| Workflow state | Flow+ | Flow+ (phase 2 trigger only) |
| Responses list and export for kind M | **DMS UI only.** fORM- does not offer them, so DMS classification and folder RBAC cannot be bypassed. | fORM- |

**New fORM- tables.** Migrations start at 0025. All are org-scoped with forced RLS and composite FKs, unless noted.

```sql
org_dms_links(org_id PK, dms_tenant_id UNIQUE, status, created_at)
tenant_routing(dms_tenant_id PK, stage text CHECK (stage IN ('off','shadow','editor','fill','full')),
               dms_write_path text CHECK (dms_write_path IN ('B','A_compat')) DEFAULT 'B',
               compat_profile bool DEFAULT true, a_compat_sunset date, updated_by, updated_at)
               -- global; read via definer fn by gateway; every change audited
dms_form_links(org_id, form_id, dms_workspace_id, master_id UNIQUE, form_builder_id, dms_slug,
               source, kind CHECK (kind IN ('M','D')), flag_override, last_synced_hash,
               last_good_json jsonb, sync_state)
dms_slug_history(dms_tenant_id, dms_slug, master_id, PRIMARY KEY (dms_tenant_id, dms_slug))  -- global, definer read
dms_field_map(org_id, form_version_id, block_id, dms_field_id, dms_field_name, dms_type, codec, parent_block_id)
dms_projections(org_id, submission_id, kind CHECK (kind IN ('create','update','files')), idempotency_key,
                state CHECK (state IN ('pending','in_flight','done','failed_retryable','failed_terminal',
                'needs_attention','blocked_locked')), dms_record_id, attempts, last_error jsonb)   -- monthly partitions
dms_sealed_tokens(org_id, session_id PK, enc bytea, expires_at)   -- KMS envelope; P1-P4 only; column-granted away from fr_app reads
dms_inbox(event_id PK, topic, partition, offset, received_at, processed_at)   -- system actor
```

Also needed: a migration that widens `user_identities.provider` CHECK to include `'dms'` (fORM-:packages/db/migrations/0006_auth.sql:73).

### 4.4 Data flows

**F1. Create a master (dms-ui "Continue").**
1. dms-ui sends the browser to `/formbuilder/{t}/create?template&utm_source=master&utm_medium=create&payload&hash&redirect_url`, unchanged (MasterFormUI.tsx:834-838).
2. The gateway sees the tenant stage is ≥ `editor`. It reads the `token` cookie (auth-fe:src/components/Cookies/setCookie.tsx:1-12), verifies it (§5.1), and mints a one-time hand-off code. The code is 256-bit, stored hashed, valid 60 s, single use, and bound to {tenant, sub, target, payload digest}. The gateway then sends 302 to `forms.<domain>/dms/{t}/masters/new?code=`.
3. `payload` is decoded **as prefill only**. Its SHA-256 is unkeyed and forgeable (monorepo:dms-ui/utils/hashData.ts:6-33). This is safe because every value from it (name, `doctype_ids`, `folder_ids`, classification) is sent to dms-api **as the user**. Doctype and folder options are fetched live from DMS. `redirect_url`/`returnUrl` are honoured only if they match `^https://dms\.<domain>/dms-v2/`.
4. The user signs in through the code exchange and edits in the builder under the DMS-compat profile. Nothing is written to DMS before publish, so no orphan masters are created.
5. **Publish saga.** Each step:

   | Step | Action |
   |---|---|
   | (a) | Compile the v2 version. |
   | (b) | `exportOpnForm(v2, prev=null)`, with a round-trip self-check. |
   | (c) | `POST /api/dms/v1/master/form` with `source:'dms'` (Flow+ only lists `source='dms'`: dms-api:app/Http/Controllers/Api/v1/MasterController.php:130), classification, doctypes and folders. This route enforces `masters.create` and the Flow+ structural guard (dms-api:MasterFormService.php:170-172). |
   | (d) | Store the link (master id, form_builder id, slug). |
   | (e) | Commit the fORM- version live. |
   | (f) | Redirect to `{returnUrl}/{t}/metadata`. |

   - If (e) fails after (c), `dms.sync.master` repairs it with an idempotent PATCH.
   - DMS 422 errors (duplicate name, duplicate field id) become RFC 9457 problems.

**F2. Edit a master.**
1. The gateway resolves `/{t}/{slug}/edit` via `dms_slug_history`, else `form-by-slug`.
2. **Drift check.** fORM- hashes `GET v1/master/form/{id}` and compares it with `last_synced_hash`. No master-update event exists (dms-api dossier §0.7). On a mismatch, fORM- re-imports, merges, and shows "external changes merged".
3. Publish sends `PATCH v1/master/form/{id}` with `exportOpnForm(v2, prev)`.
4. A guard block (4xx `workflowBlocked`, 503 `5031`: dms-api:app/Services/MasterWorkflowStructuralGuard.php:48-54) makes publish fail with the workflow named. The draft is kept.
5. Field ids never change. A removed block becomes a soft remove, and the column stays.
6. **Never** use `PUT /form/{id}` (it skips the guard) or `DELETE /form/{id}` (it orphans the master: FormService.php:1351-1354).

**F3. Export rules that prevent breakage.**
- **Conditional required.** Any field that is the target of `hide-block` or `make-it-optional` logic is exported with `required:false`. The conditional rule lives only in fORM-'s server validator. Path B enforces `required` unconditionally (dms-api:app/Rules/BaseFieldsValidationRule.php:49-57). This is the most likely cutover bug if missed.
- **Options.** Export `select.options[{id,label}]` and preserve the ids. The record value is the label, which matches history (FB:OpenFormField.vue:471-476) and path B's option check.
- **Layout blocks.** `divider`, `nf-image` and `nf-text` keep exporting as fields, because they hold `field_N` columns. `nf-page-break` is exported as today.

**F4. Fill and submit (kind M).**
1. Entry is `/formbuilder/{t}/{slug}[?submission_id]`, `/sharemaster/{id}` or a public link. The gateway hands off to `forms.<domain>/dms/{t}/{slug}` (authenticated) or `/f/{slug}` (public).
2. The existing pipeline runs (fORM-:apps/api/src/submit/pipeline.ts): admission, `Idempotency-Key`, version acceptance, access, and **full server validation**, including logic-aware required and `validation.error_conditions`. The latter were authored in Form+ but never enforced, so they are imported **disabled**.
3. A new **DMS pre-validator** applies the path-B rules: dates, option membership, int32, phone and email.
4. Tx1: insert the submission with `status=projecting`, the idempotency claim and `dms_projections(create,pending)`. Commit.
5. The answers are encoded with the codec (§9.1).
6. **Authenticated** submissions call path B synchronously with an 8 s budget. **Public** submissions return the ending immediately and the worker projects them.
7. Tx2: set the submission `complete`, record `dms_record_id`, and enqueue `dms.project.files` and `submission.fanout`. Notifications and webhooks go out only after DMS acknowledges.

Projection outcomes:

| DMS answer | Authenticated user sees | Public respondent sees | State |
|---|---|---|---|
| 201 | Success, redirect to the allowlisted `redirect_url` | Thank-you page | `done` |
| 422 / 409 duplicate PK | Field errors | (async) owner notified, "sync issues" view | `rejected_by_dms` / `needs_attention` |
| 5xx / timeout / breaker open | "Saved, syncing" | Thank-you page | `failed_retryable`, backoff from 1 min up to 24 h, then DLQ and alert |

**F5. Record write target by phase.**

| Phase | Authenticated | Public |
|---|---|---|
| P3-P4 (no DMS change) | `POST /api/dms/master-records {master_id, json_data}` with the sealed user JWT | `POST /api/dms/master-records-by-slug/{slug}` server-to-server (dms-api:routes/api.php:606) |
| P5+ (GA) | `POST /api/dms/internal/v1/forms/records` (app token, `metadata.user_id`, `Idempotency-Key`) | Same route, `user_id:null`, `ref.source:'form'` |

- **Keys.** Path-B validation accepts field ids (dms-api:app/Rules/MasterFieldsValidationRule.php:73-84). **VERIFY** that the write path accepts them too. If it does not, send names from `dms_field_map`.
- **Before idempotency (P3-P4)** there are no blind retries. fORM- retries only on connection errors that happened before the request was sent. An ambiguous timeout goes to `needs_attention`, unless the master has a primary key that permits lookup-before-retry.
- **Behaviour changes versus path A, which must be shown to tenant admins:**
  - Create triggers now fire Flow+ runs and lock the record.
  - Validation is stricter.
  - Public writes honour `master_share_settings.is_public_enabled` ("Responses Are Closed.": dms-api:MasterRecordController.php:195-204).
- **Pre-cutover report per tenant** lists: masters with create triggers in `master_workflow_events`, masters with public Form+ links but `is_public_enabled=0`, and masters whose required/logic combination changes. Flagged masters stay on Form+ until an admin acknowledges.

**F6. Edit a record.**
1. The gateway receives `?submission_id={recordId}` (MasterDetailView.tsx:658-686).
2. **Prefill always reads DMS**, never the journal, because Flow+ write-back emits no event (dms-api:app/Console/Commands/WorkflowKafkaConsumer.php:329-333). The codec decodes legacy values (`IN+91…` phones, comma-joined lists, `Y-m-d` dates).
3. Write is `PATCH` (path B: `form/slug/{slug}/update/{id}` in P3-P4; internal route with `If-Match` in P5).
4. A 409 `4092` shows "locked by workflow <name>" and is not queued.
5. Asynchronous retries are serialised with pg-boss `singletonKey = dms_record:<id>`.

**F7. Delete.**
- Record deletion stays in DMS.
- Master deletion stays in DMS (`DELETE /masters/{id}`, which emits `dms.master.delete`). fORM- archives its link on a 404 or on the inbox event.
- Kind S deletion is unchanged.

**F8. Files.**
1. Upload goes to fORM- S3 staging (WP-1.14), then MIME sniff and ClamAV (`file.inspect`).
2. After the record exists, `dms.project.files` runs:
   - **P3-P4:** stream chunks to storage-api `/api/media/upload-chunk-new` and `/complete-upload-new`, then `POST /api/dms/multiple-document-upload-new` with a **truthful** `user_id` (the actor, or the form owner for public forms, as Form+ does: FB:lib/file-uploads.js:248-285). Calling these from the backend adds no exposure beyond what exists today.
   - **P5+:** `POST /api/dms/internal/v1/forms/records/{id}/documents` with `source_url` = a 10-minute presigned GET. **DMS pulls the bytes**, the actor comes from metadata, and the call is idempotent on `(record_id, field_id, sha256)`.
3. Either way, DMS emits `FileTagged` (dms-api:app/Services/DocumentService.php:1034-1062).
4. State is tracked per file, so there is never a second record (this fixes FB:OpenCompleteForm.vue:597-607).
5. Staging files are deleted 24 h after `done`.

## 5. Identity and tenancy

### 5.1 Token verification
- Passport tokens are RS256, have no `kid`, carry claims `aud, jti, iat, nbf, exp, sub, scopes:[]`, have **no tenant claim**, and live about 365 days (auth-api:app/Services/AuthService.php:262; dossier platform §1.1).
- fORM- adapter `packages/adapters/src/identity-dms` uses `jose` and checks:
  - `alg` pinned to RS256 (never HS*, which differs from workflow-api: monorepo:…/AuthorizationMiddleware.ts:130-262);
  - `aud` pinned to the personal-access client id;
  - `exp` and `nbf` with 60 s skew;
  - key from `PASSPORT_PUBLIC_KEY` (env PEM, as dms-api has), or JWKS once auth-api adds it.
- Tokens are never logged. (dms-api logs them: VerifyToken.php:106-114. Don't copy that.)
- A DMS token is used **only as input to an exchange**. It is never a per-request credential in fORM-.

### 5.2 Session exchange: `POST /v1/auth/dms/exchange`
- **Inputs:** a gateway `code`, or (for the embed and API surface) `Authorization: Bearer` plus the tenant from a signed ticket or the launch path. `org_id` is **never** taken from a header alone.
- **Steps:**
  1. Verify the code or JWT.
  2. Look up `org_dms_links`. If it is missing or suspended, return 403. Provisioning is explicit (§5.3).
  3. Prove membership. Call dms-api with the user's bearer plus `X-Tenant-Id`/`X-Workspace-Id`; `VerifyToken` runs `User::find(sub)` in the tenant DB (dms-api:app/Http/Middleware/VerifyToken.php:61-77). Then fetch the authz snapshot `GET /api/v1/internal/authz/users/{sub}` with fORM-'s `X-Service-Token` (dms-api:routes/api.php:210-213; app/Services/WorkflowAuthzSnapshotService.php:32-80).
  4. JIT-upsert the user, `user_identities(provider='dms', subject='<tenant>:<sub>')`, the membership with the mapped role, and the teams (the user's workspaces).
  5. Mint `__Host-fr_sess` with `first_factor='sso'` (fORM-:packages/db/src/schema/auth.ts:6). Settings: 12 h idle, 14 d absolute, rotated. fORM- TOTP and notice flows are skipped for these users.
  6. P1-P4 only: seal the DMS JWT with KMS envelope encryption into `dms_sealed_tokens`. It is used only server-side for user-attributed dms-api calls and is deleted on logout or expiry. It goes away in P5, when the app token replaces it.
- **Revocation.** Membership is re-checked every 15 min for active sessions and on every re-exchange. A user `status=7` ("Form access revoked", auth-api:app/Services/AuthService.php:253-256) is refused. Inbox hints (`dms.user.delete|update`, `dms.user.permission.updated`) trigger an immediate re-check.
- **Host.** fORM- lives on `forms.<domain>`. `__Host-` cookies are host-wide, and DMS cookies are JS-readable with `path=/` (monorepo:dms-ui/lib/dms-session.ts:19-21), so the two must not share a host. CSRF stays same-origin (ADR-0008).

### 5.3 Tenant mapping
- **1 DMS tenant = 1 fORM- org** (`org_dms_links`, unique on both sides). DMS tenant DBs are the isolation unit, and users span workspaces.
- **DMS workspace = fORM- team.**
  - Today `forms.team_id = org_id` (fORM-:apps/api/src/routes/forms.ts:282). It becomes `dms_workspace_id` for DMS-linked forms.
  - `app_teams()` (fORM-:packages/db/migrations/0001_foundation.sql:21-26) holds the user's workspaces, and team-scoped RLS policies are added to forms and submissions. That gives workspace isolation without one org per workspace.
  - `dms_workspace_id` is sent on every dms-api call.
- **Provisioning:**
  - Idempotent `PUT /v1/internal/dms/links/{tenantId}` (service token), wrapping `create_org()` as system (fORM-:packages/db/migrations/0008_orgs.sql:158).
  - CLI `form-admin dms link <tenant>`.
  - Only tenants with a `tenant_routing` row can be linked.
  - Suspend and delete arrive later through the same endpoint, or through `iam.tenant.*` hints. `org.delete` must be built.

### 5.4 Permission mapping
This is a code constant beside `ROLE_PERMISSIONS` (fORM-:apps/api/src/authz/roles.ts:41-49), recomputed at every re-check.

| DMS signal | fORM- role (for DMS-linked forms) |
|---|---|
| Role owner / administrator / admin | `admin` |
| Right `masters.create` | `creator` (create, edit, publish) |
| Any tenant member (`masters.update` is stubbed true: dms-api:app/Policies/MasterPolicy.php:161-165) | Fill and edit records. DMS enforces locks and validation. |
| `audit.view` | read the fORM- audit trail |
| `forms.*` rights (seeded and hidden: auth-api:database/seeders/RightsCatalogSeeder.php:56-67) | Ignored in v1. Decision O6. |
| `data.route` | **Never** derived. Admin only, explicitly granted (gates fORM- webhooks). |

fORM- is never more permissive than DMS. Record reads and writes always go to DMS **as the user**, or with `metadata.user_id`, so DMS RBAC remains the authority.

### 5.5 Service principals
| Caller → callee | Mechanism |
|---|---|
| fORM- → dms-api (P1-P4) | Sealed user JWT (authenticated) or the public slug route (public) |
| fORM- → dms-api (P5+) | `X-App-Token` + `resolve.app.metadata.tenant` (existing pattern: dms-api:routes/api.php:238-255; app/Http/Middleware/AppTokenAuth.php), with permissions `forms.master.write`, `forms.record.write`, `forms.record.read`, `forms.documents.write`, scoped by `allowed_tenant_ids`, token stored as sha256 |
| fORM- → dms-api authz snapshot | `X-Service-Token` (`workflow.service.token`) |
| fORM- → workflow-api | A distinct `X-Service-Token` from `WORKFLOW_INTERNAL_SERVICE_TOKENS` (monorepo:…/serviceTokenAuth.ts:24-27), plus an HMAC body signature |
| workflow-api → fORM- | ES256 launch tickets (workflow-api private key, fORM- pins the public key) and HMAC callbacks |
| dms-ui / workflow-ui → fORM- embed | Embed ticket minted by fORM- from the user's DMS bearer (§7.2) |

## 6. Eventing contracts

### 6.1 Principles
- **fORM- is not a Kafka producer in v1.** Three reasons:
  - MSK is PLAINTEXT with no auth (monorepo:apps/backend/workflow-api/src/infrastructure/messaging/kafkaClientConfig.ts:13).
  - Producing `dms.masterrecord.*` would bypass the `master_workflow_events` filter and the lock.
  - DMS already emits the canonical events from path B.
- **Inside fORM-:** pg-boss transactional outbox (ADR-0007) with signed envelopes (ADR-0016). Ordering is per aggregate via `singletonKey`.
- **Inbound Kafka is a hint.** It is inserted into `dms_inbox` (`ON CONFLICT DO NOTHING`), then handled by an idempotent job that **re-reads DMS** before acting. Nothing destructive happens on message content alone.

### 6.2 fORM- internal queues (new)
| Queue | singletonKey | Idempotency key sent downstream |
|---|---|---|
| `dms.project.record` | `org:dms_record:<recordId or submissionId>` | `fORM-:{org}:{submissionId}:create` / `…:edit:{revision}` |
| `dms.project.files` | `org:submission` | `(record_id, field_id, sha256)` |
| `dms.sync.master` | `org:master` | n/a (PATCH is idempotent) |
| `dms.reconcile` (cron every 5 min) | singleton | Finds `projecting` older than 2 min and `in_flight` past the lease |
| `dms.import.forms` | `org:master` | n/a |
| `flow.step.complete` | `org:stepId` | `submissionId` |
| `dms.inbox.handle` | `event_id` | n/a |

### 6.3 Consumed topics (P5, optional; consumer group prefix `form_`)
- Topic names may carry an environment prefix. Match by suffix (monorepo:packages/iam-contracts/src/kafka/dmsKafkaTopics.ts:22-30).
- Settings: `fromBeginning:false`, manual commit after the inbox insert.

| Topic | Event | fORM- action (after re-read) |
|---|---|---|
| `dms.user.update`, `dms.user.delete` | DMS envelope | Re-check membership; revoke sessions |
| `dms.user.permission.updated` | DMS envelope | Recompute role |
| `dms.master.delete` | `Master/Delete` | Archive the form, mark the link detached |
| `workflow-trigger-done-topic-v2` | `WORKFLOW_TRIGGER_DONE` | Re-enqueue `blocked_locked` edits for `payload.instanceId`. Pin the `-v2` name: the workflow-api default lacks it (monorepo:…/kafkaTopicConfig.ts:49). |
| `dms.masterrecord.metadata.update` | `dms.masterrecord.metadata.update_requested` v2 | Optional: refresh the cached record view. DMS stays the truth. |

**DMS envelope (consumed).** `tenant_id` sits only inside `payload` (dms-api:app/Services/OutboxEventPublisher.php:107-142):

```json
{
  "event_id": "8f3c2a8e-6b1d-4f8a-9d1e-2b7c0e5a9f11",
  "aggregate_type": "Master",
  "aggregate_id": "0b6e9c3a-5d2f-4c71-a1e4-7f9a2d3b8c55",
  "version": "1.0",
  "occurred_at": "2026-11-23T10:15:02Z",
  "payload": { "tenant_id": "…uuid…", "workspace_id": "…uuid…", "id": "0b6e9c3a-…", "deleted_by": "…uuid…" }
}
```
Kafka headers: `event_type`, `version`, `event_id`, `correlation_id`, `traceparent`, `source`. The key is `aggregate_id`.

**Events DMS emits because of fORM- writes (unchanged contract, for reference).** `dms.masterrecord.create` is gated by `master_workflow_events`:
```json
{
  "event_id": "…", "aggregate_type": "MasterRecord", "aggregate_id": "<recordId>", "version": "1.0",
  "occurred_at": "…",
  "payload": { "master_id": "…", "master_record_id": "<recordId>", "workspace_id": "…",
               "created_by": "<userId|null>", "workflow_trigger": true, "workflow_id": "…",
               "workflow_trigger_type": "on record creation", "json_data": { "Invoice No": "INV-1" } }
}
```

### 6.4 Future producer (P8+, only after MSK gets authentication): `form.submission.{created,updated,deleted}`
References only, no answers, in the DMS envelope. A versioned zod contract is published as `@dmacq/form-contracts`.
```json
{
  "event_id": "…uuidv7…", "aggregate_type": "FormSubmission", "aggregate_id": "<submissionId>",
  "version": "1.0", "occurred_at": "…",
  "payload": { "tenant_id": "…", "workspace_id": "…", "form_id": "…", "form_version_id": "…",
               "master_id": "…|null", "record_id": "…|null", "status": "complete" }
}
```
Headers: `event_type=form.submission.created`, `source=form`, `traceparent`.

**Audit forwarding (P6).** fORM- definition events (publish, archive) go to `audit-events` using the audit-logs fields and the seeded catalog names "Master Created" / "Master Edited" (dms-api:database/seeders/AuditTypeActionSeeder.php:121-143). DMS records no audit for form definitions today:
```json
{ "event_id": "…", "tenant_id": "…", "workspace_id": "…", "user_id": "…", "service": "form",
  "module": "Master", "action": "master.master-edited", "resource_type": "Master",
  "resource_id": "<masterId>", "status": "SUCCESS", "metadata": { "form_version_id": "…" } }
```

### 6.5 Flow+ contracts (HTTP)
**Launch ticket** (ES256 JWS from workflow-api, ≤ 15 min, `jti` single use):
```json
{ "iss": "flow", "aud": "form", "tenantId": "…", "workspaceId": "…", "workflowRunId": "…",
  "stepId": "…", "nodeId": "…", "userId": "…", "formId": "…", "formVersionId": "…",
  "recordRef": { "masterId": "…", "recordId": "…" }, "target": "writeback", "exp": 1795000000, "jti": "…" }
```
**Step completion** (`POST /v1/internal/run-steps/:stepId/action` on workflow-api; `X-Service-Token` + `X-Signature: t=…,v1=<hmac>`):
```json
{ "decision": "Approve", "actorUserId": "…", "idempotencyKey": "<submissionId>",
  "actionData": { "form": { "submissionId": "…", "formVersionId": "…", "answersDigest": "sha256:…",
                            "dmsRecordId": "…|null",
                            "fieldUpdates": [ { "fieldId": "<dms field uuid>", "value": "Approved" } ] } } }
```

## 7. API surface fORM- adds

- fORM- serves everything on **`forms.<domain>`** under `/v1` (never `/api/forms`).
- The gateway owns the legacy paths on `dms.<domain>`.
- All new routes declare `auth` explicitly, so the auth-none tripwire (fORM-:apps/api/src/app.test.ts:722-756) must be updated deliberately.

| Path | Host | Auth | Purpose |
|---|---|---|---|
| `GET /formbuilder/*`, `/forms/*`, `/sharemaster*` | dms host (gateway) | none / DMS cookie read | Proxy or hand off |
| `GET /dms/{t}/masters/new`, `/dms/{t}/masters/{id}/edit`, `/dms/{t}/{slug}`, `/dms/{t}/records/{id}/edit` | forms host (SPA) | `?code=` → exchange | Landing pages |
| `POST /v1/auth/dms/exchange` | forms | code or Bearer + ticket | Mint the session |
| `GET /v1/dms/masters/{id}` · `POST /v1/dms/masters/{id}/publish` · `GET /v1/dms/masters/{id}/drift` | forms | user (session) | Editor saga |
| `GET /v1/dms/records/{masterId}/{recordId}` · `PATCH …` | forms | user | Record read and edit via DMS |
| `POST /v1/dms/records/{masterId}` | forms | user | Authenticated record create |
| `GET /v1/dms/sync-issues` · `POST /v1/dms/sync-issues/{id}/retry` | forms | user (`ops.manage`) | Projection triage |
| `POST /v1/dms/embed-tickets` | forms | DMS Bearer + `X-Tenant-Id`/`X-Workspace-Id` (CORS: dms host only) | Mint the read-only view ticket |
| `GET /embed/records/{masterId}/{recordId}?ticket=` | forms (`frame-ancestors https://dms.<domain>`) | ticket | Read-only rich render |
| `GET /flow/fill?ticket=` | forms (`frame-ancestors` dms host) | launch ticket | Flow+ form task |
| `GET /v1/internal/flow/forms?tenant=&workspace=` | forms | `X-Service-Token` (workflow-api) | Form picker |
| `GET /v1/internal/flow/forms/{id}/versions/{v}` | forms | service token | Publish validator |
| `POST /v1/integrations/flow/form-requests` (P8) | forms | service token + `Idempotency-Key` | Dedicated `form-task` node |
| `PUT /v1/internal/dms/links/{tenantId}` | forms | service token (ops) | Provision the org link |
| `PUT /v1/internal/dms/routing/{tenantId}` | forms | `platform` actor (ops, MFA) | Stage changes (audited) |
| `GET /v1/internal/gateway/routing/{tenantId}` | cluster-only (NetworkPolicy) | gateway mTLS / service token | Gateway lookup |
| `POST /v1/internal/jobs/cancel` | forms | service token | realtime `FORMPLUS_API_URL` replacement (optional) |

Hand-off code exchange, ticket verification and `/embed/*` keep `frame-ancestors 'none'` everywhere else (fORM-:apps/builder/security/headers.ts:61). `postMessage` always names an explicit target origin, never `"*"` (do not repeat FB:OpenCompleteForm.vue:558-561).

## 8. Form+ replacement map

Stages per tenant (`tenant_routing.stage`):

| Stage | Behaviour |
|---|---|
| `off` | Proxy everything to Form+ |
| `shadow` | Proxy, while fORM- imports and diffs |
| `editor` | fORM- serves master create and edit |
| `fill` | Also record create, edit and public forms |
| `full` | Also the `/forms/*` landing and invite links |

A per-master `flag_override` exists for masters that fail import.

| Repo | Touchpoint (evidence) | Change | Phase | Owner |
|---|---|---|---|---|
| infra (ALB, not in repo) | `/formbuilder*` routing (dossier touchpoints §0 gap 2) | Repoint to `fr-gateway`. Keep the Form+ target group as upstream and break-glass. | P1 | infra |
| infra | `/forms/*`, `/sharemaster*` (**VERIFY** the current rules: dms-api emits root `/sharemaster`, dms-ui basePath is `/dms-v2`, monorepo:dms-ui/next.config.mjs:21) | Route to the gateway | P3 | infra |
| infra | New host `forms.<domain>`, cert, WAF; DNS `formplus.dmacqdms.com` → gateway | Add | P0/P6 | infra |
| monorepo dms-ui | MasterFormUI.tsx:262-313, 779-839 (create/edit hand-off) | **None** for cutover. P7: server-signed hand-off (D7), delete `utils/hashData.ts` and the `master-store.ts` localStorage mirror. | P7 | DMS |
| monorepo dms-ui | MasterDetailView.tsx:658-686, 949-983 (record create/edit) | None (gateway) | — | — |
| monorepo dms-ui | ShareMasterSidePanel.tsx:355-393, ShareMasterFullPage.tsx:188-244 | None (gateway) | P3 | — |
| monorepo dms-ui | ShareMasterFullPage.tsx:246-341 (native renderer) | Keep as fallback. Decide in P7 (O7). | P7 | DMS |
| monorepo dms-ui | MasterDetailView record panel | Optional "View response" iframe (`/embed/records/…`) behind a runtime flag | P6 | DMS |
| monorepo dms-ui / workflow-ui | `tokens.css` "FORMS+" tokens | Optional re-skin | P7 | DMS |
| dms-api | URL builders `form_builder_slug`, `DOMAIN_URL`, `HOST_URL` (MasterService.php:1918-1940; MasterFormService.php:108-110; MasterShareService.php:1005-1007) | None. They keep pointing at `/formbuilder`, which the gateway owns. | — | — |
| dms-api | `FormBuilder` slug regenerated on rename (app/Models/FormBuilder.php:70-78) | Stop regenerating it (D4). The gateway also keeps `dms_slug_history`. | P5 | DMS |
| dms-api | `createSubmission` (routes/api.php:575-580) | Not called by fORM- (except `A_compat`). 410 for migrated masters, then closed. | P5/P7 | DMS |
| dms-api | Public `form-by-slug[/find]` (routes/api.php:600-601) | Gateway slug resolution only. Closed or authenticated after retirement. | P7 | DMS |
| dms-api / storage-api | `multiple-document-upload-new` (DocumentController.php:1189-1196), storage-api `*-new` (routes/api.php:14-19) | Used server-side by the fORM- worker in P3-P4, replaced by the internal documents route in P5, closed in P7 | P5/P7 | DMS |
| dms-api | Internal forms API, `masters.form_engine`, idempotency (§12) | Add | P5 | DMS |
| reports-api / auto-indexing-api | `share_url`, `submissions_url = HOST_URL…/show/submissions` (reports-api:app/Services/FormService.php:142-180) | The gateway maps `/show*` to the DMS master detail page. Align `DOMAIN_URL`. Make sure duplicate forked form routes are not routed to. | P3 | fORM- + DMS env |
| reports-api | Invite links to `formplus.dmacqdms.com/form/{token}/…` (app/Notifications/SendInviteNotificationExternalUser.php:52) | Gateway shows a friendly "link expired, contact sender" page (the route is already dead in Form+) | P6 | fORM- |
| auth-frontend | Forms redirects ×6 (sso/callback/page.tsx:206-207; password/index.tsx:281,336; otp-verification/index.tsx:529; AlreadyExistingUserForm.tsx:269; SignUp.tsx:480-489) | None in code. `/forms/{t}` hits the gateway, which goes to the fORM- home at stage `full`. Optionally set `NEXT_PUBLIC_FORMS_DOMAIN`. | P6 | infra / DMS env |
| auth-frontend | Forms+ copy, trial, checkout, transfer card, `ProductFormLogo`, dead `form.service.tsx`, `formBuilder` slices | Copy and cleanup; billing per O5 | P7 | DMS |
| auth-api / subscription-api | Product `Form(s)`, `source='forms'` plans (AuthService.php:2002-2015; ProductSeeder.php:22-28 drift) | Decision O5 only | later | product |
| realtime | `FORMPLUS_API_URL` job cancel (src/index.ts:328-338) | Unset, or point at `/v1/internal/jobs/cancel`. Do not publish to realtime or websocket until their tenant isolation is fixed. | P7 | DMS env |
| monorepo workflow-api | Internal step action, launch tickets, task-form validator, `fieldUpdates` staging | Add (D6) | P6 | Flow+ |
| monorepo workflow-ui | Form picker, take-action iframe, read-only view, unhide Task (form variant) | Add (D8) | P6 | Flow+ |
| classic frontend `dmacq-dms-workflow-frontend` | DocType property forms and legacy Masters (**not read**) | The gateway classifies `form_builderable_type=DocType` as kind D and **always proxies** to Form+. Follow-up discovery is needed. | P8 | both |
| storage-api | `SyncSFTPFiles` dead imports | Remove (hygiene) | P7 | DMS |
| doc-viewer | `app_key` | None unless fORM- embeds the viewer | — | — |

## 9. Migration

### 9.1 Form schema import: OpenForm JSON → fORM- schema v2
- **Source:** `GET /api/dms/v1/master/form/{id}` for each master with a `form_builders` row. List through `GET form?source=dms` and `?source=forms` (**VERIFY** completeness; the list is not workspace-filtered: dms-api:app/Repositories/FormBuilderRepository.php:63-105).
- **Identity:**
  - fORM- `form.id = uuidv5(ns, master_id)` (client-chosen ids are supported: fORM-:apps/api/src/routes/forms.ts:174).
  - **Block id = OpenForm field `id` = `master_fields.id`.** fORM- block ids accept `/^[A-Za-z0-9_-]{1,64}$/` (fORM-:packages/schema/src/v2/zod/primitives.ts:16).
  - New fields get UUIDv4 ids, which are globally unique as DMS requires (dms-api:MasterFormController.php:46-48).
- **Output:** a v2 draft plus `ImportNote[]` (lossy / unsupported / behaviour-change), following the `migrateV1ToV2` pattern. In `shadow` it is published as version 1, `origin: imported`, with **no write-back** to DMS.

| OpenForm type / option | v2 block | DMS type on export | Record value codec | Note |
|---|---|---|---|---|
| `text` | `short_text` (`long_text` if `multi_lines`) | textinput / textarea | string | `secret_input` → masked widget; `restriction` → v2 validation; `max_char_limit` kept |
| `rich_text` | `long_text` (rich) | textarea | sanitised HTML string | **VERIFY** the v2 rich variant. Sanitise on render (Form+ used raw `v-html`). |
| `email`, `url` | `email`, `url` | email, url | string | |
| `number` | `number` | number | decimal string. int32 check if the column is numeric. | min/max kept if present |
| `phone_number` | `phone` | phone | **O3** (default: E.164 digits without `+`) | Legacy `IN+91…` decoded on read |
| `date` (+range, with_time, formats) | `date` / `date_range` / `datetime` | date (`datetime`/range → text) | `YYYY-MM-DD`; datetime → ISO text | Path A truncated time; fORM- no longer does |
| `select` (+`without_dropdown`) | `single_choice` | dropdown | option **label** | Option ids preserved in `select.options[].id`. "Allow creation" disabled for kind M. |
| `multi_select` | `multi_choice` | multi_select | comma-joined labels (O4: JSON array) | Warn when an author types a comma in a label |
| `checkbox` (+toggle) | **new `yes_no` block** | boolean | 0/1 | Registry addition |
| `rating`, `scale`, `slider` | `rating`, `linear_scale`, `number` (slider UI) | number | number | |
| `files` | `file_upload` | files | `"<name>_<unique>"` strings + document registration | Matches FB:FileInput.vue:352-357 |
| `signature` | `signature` | files | PNG → document | **VERIFY** what path B accepts |
| `divider`, `nf-image`, `nf-text`, `heading` | content blocks | kept as fields (column stability) | none | |
| `nf-page-break` | page boundary | exported as today | none | Next/Previous labels kept |
| hidden/legacy `radio`, `matrix`, `time`, `full_name`, `address` | `single_choice` (radio), `matrix`, `time`, `full_name`, `address` | dropdown / text(JSON) / text | JSON-encoded where complex | May exist in real data (dms-api accepts any type: MasterFormRequest.php:87) |
| `barcode`, `nf-code`, `color` | `short_text` + note, or master stays on Form+ | text | string | |
| `logic` (6 actions; and/or tree; open_filters operators) | `logic@2` rules | `logic` exported unchanged | n/a | Now **evaluated server-side**. Unsupported operator → rule disabled + note. |
| `validation.error_conditions` | v2 validation rules, **imported disabled** | kept in JSON | n/a | Never enforced before; the author must opt in |
| `required`, `hidden`, `disabled`, `width`, `help`, `placeholder`, `prefill`, `hide_field_name` | envelope props / layout | same keys | n/a | Conditional-required export rule (F3) |
| DMS overlays `primary`, `numeric`, `specialChars`, `increment*`, `autoIncrementPattern`, `elements[]`, `advanced_rules` | preserved under `x.dms` | round-tripped verbatim | n/a | dms-api:app/Support/FormBuilderFieldJson.php:10-22 |
| Design / Settings (theme, password, closing, captcha, SEO) | not imported | n/a | n/a | dms-api never stored them (FormService.php:131-213) |

**Parity harness.** Each item is a gate for that master:
1. **Round-trip:** `exportOpnForm(importOpnForm(j), j) ≡ j` on all DMS-relevant keys.
2. **Render diff:** Playwright on staging (build server, through `~/bin/pw-gate`) compares Form+ and fORM- field list, order, labels, required, options and pages.
3. **Value corpus:** decode, then encode, a sample of real records per master; the result must be identical.

Masters that fail stay on Form+ via `flag_override`. Fixtures come from sanitised real `json_data`.

### 9.2 Submissions
- **No migration.** They are already DMS master records with linked documents. fORM- renders and edits them through the codec's legacy decoders.
- Before a tenant reaches `fill`, DMS runs `elasticsearch:index-missing-documents --all` for that tenant once. Path-A records are otherwise only indexed by the 02:00 sweep (dms-api:routes/console.php:21-25).
- In-browser Form+ drafts (`form-14194-pending-submission-*` in localStorage) are lost at cutover. Announce this.

### 9.3 Coexistence and per-tenant cutover
| Step | Gate to proceed |
|---|---|
| `off` → `shadow` | Org linked; import job finished; parity report produced |
| `shadow` → `editor` | ≥ 95% of the tenant's masters pass all three parity gates; pre-cutover report acknowledged by the tenant admin |
| `editor` → `fill` | One week of editor use with 0 drift incidents; captcha live; load test passed for the tenant's size; trigger and share report acknowledged |
| `fill` → `full` | Two weeks with projection `failed_terminal` < 0.1% and p95 lag < 30 s |
| Point of no return | 30 days at `full` without rollback. Then `compat_profile=false` (new block types, Design tab). |

- Both engines read and write the **same DMS rows** during coexistence. There is never a dual-write of data, only a definition kept Form+-renderable.
- `A_compat` (path-A writes) is allowed only with a `a_compat_sunset` date ≤ 60 days out.

### 9.4 Rollback ladder (each is lossless while `compat_profile=true`)
1. **Per master:** `flag_override=formplus`. The gateway proxies. Form+ renders `form_builders.json_data`, kept current by fORM-, and `last_good_json` can be restored with one admin action.
2. **Per tenant:** lower `tenant_routing.stage`. It takes effect within the 60 s cache.
3. **Global:** gateway `GLOBAL_FORCE_PROXY=1`.
4. **Infra:** ALB rule back to the Form+ target group (runbook, minutes).

Lost on rollback: v2-only presentation (Form+ ignored it anyway), server-side validation, and the journal (it stays in fORM- but is unused). Records and files are untouched.

## 10. Flow+ integration

### 10.1 Form task, phase 1 (no executor change)
**Facts relied on:**
- Flow+ is anchored on a DMS master (monorepo:…/WorkflowUseCases.ts:2280-2283).
- The `task` node is a human gate, hidden behind `NEXT_PUBLIC_SHOW_WORKFLOW_TASK_NODE` (workflow-builder-v1-ui-hides.ts:55-65).
- Conditions read only `triggerData` (DynamicWorkflowExecutor.ts:2303-2308).
- The triggering record is locked until `WORKFLOW_TRIGGER_DONE` (dms-api:OutboxEmitterForWorkflow.php:73).
- `serviceCallerAuthorized` is hard-coded false (monorepo:…/controllers/workflowStepActionActor.ts:15-55).

**Steps:**
1. **Builder.** Task node config adds `dataCollection.source="form"`, `formRef {formId, versionId pinned at publish}`, `outcomeRules`, `target: "writeback" | "child_record"` and `outputMapping[{blockId → dmsFieldId}]`.
   - New `form-picker` field in `node-config-field-renderer.tsx` (beside `data-collection`, :1659), fed by `GET /v1/internal/flow/forms`.
   - New validator `assertValidWorkflowGraphTaskForm`, registered at WorkflowUseCases.ts:100-105.
   - Only the form variant of Task is unhidden, per tenant.
2. **Open.** In take-action (`features/workflow-instance/main/page.tsx:3918-3963`), workflow-api mints the launch ticket (§6.5) and the iframe loads `forms.<domain>/flow/fill?ticket=`. fORM- verifies the ticket, burns the `jti`, and checks the user is in the linked org.
   - The embed session is a ticket-scoped header token held in memory, not `__Host-fr_sess`, so third-party cookie rules do not matter.
   - `context` blocks are prefilled with `masterId` and `recordId`.
3. **Response target:**
   - **`writeback` (default for "collect a few values onto this record").** Only `outputMapping` values are sent as `actionData.form.fieldUpdates`. Flow+ appends them to `pending_dms_metadata_updates` and applies them at run completion through the existing `dms.masterrecord.metadata.update` (UpdateMetadataActivities.ts:55-62). That path is lock-exempt by design.
   - **`child_record` (default for "a full response document").** The task form is bound to its own "response master" with a system field `parent_record_id`. The submission becomes a new DMS record through F4, so there is no lock conflict, and it is searchable, reportable and able to trigger workflows. The outcome is posted only after `dmsRecordId` exists.
4. **Complete.** fORM- computes the outcome label from `outcomeRules` with `@form/logic` and posts the step action (`flow.step.complete`, idempotency key `submissionId`). workflow-api calls `submitWorkflowRunStepAction` with `serviceCallerAuthorized:true`, which reuses completion rules, the action row, audit and the `TEMPORAL_RESOLVE_NODE` outbox. It requires `actorUserId` to be a step assignee. `pickDecisionEdge` branches on the label.
5. **Personal data.** Flow+ stores `submissionId`, the digest, the outcome and the explicit `fieldUpdates` only. Answers stay in fORM- or DMS.

### 10.2 Form task, phase 2 (P8)
- A dedicated `form-task` type. It already matches the four `includes("task")` human-gate predicates; the exact `type==="task"` checks (DynamicWorkflowExecutor.ts:1028-1075, 1858-1866) are extended under `patched('form-task-v1')`.
- A `createFormRequest` activity → `POST /v1/integrations/flow/form-requests` with `Idempotency-Key=<runId>:<nodeId>`.
- A `formSubmitted` signal.
- A per-run data bag readable by conditions (`patched('run-data-conditions-v1')`).
- An external-respondent `wait-for-form` variant with timeout.
- **Ship the worker before the builder.** Unknown node types pass through silently today (DynamicWorkflowExecutor.ts:2286-2289).

### 10.3 Read-only rich renderer
- workflow-ui and dms-ui call `POST /v1/dms/embed-tickets` with the user's DMS bearer and tenant/workspace headers. They receive a 5-minute ticket and iframe `/embed/records/{masterId}/{recordId}?ticket=`.
- fORM- reads the record **from DMS as that user**, so DMS RBAC applies. It picks the form version from the journal link, or the live field map for foreign records, and renders with `@form/renderer` in view mode. Files, repeating groups and logic visibility are shown.
- Values come from DMS, so Flow+ write-backs are visible.
- **Fallback:** if there is no link, fORM- is down, or the flag is off, the existing plain DMS view is shown.
- The flag is read at runtime from fORM-, not from a build-time env.
- Phase 2: a `@form/renderer` npm package for in-process React rendering.

### 10.4 Triggers
- Nothing changes. Records written via path B fire `dms.masterrecord.create|update|filetagged` through DMS's own filter and lock.
- Kind S forms cannot trigger Flow+ until a non-master trigger exists (O8). Until then, bind such a form to a master if it needs workflow.

## 11. Scaling and operations

### 11.1 SLOs
| SLI | Target |
|---|---|
| Public submit availability (fORM- accepts) | 99.9% monthly, independent of DMS availability |
| Public submit p95 latency (server) | < 400 ms |
| Authenticated record create p95 (incl. DMS) | < 2 s; hard budget 8 s |
| DMS projection lag p95 / alert | < 30 s / page at 5 min |
| Projection `failed_terminal` rate | < 0.1% |
| Gateway added latency p99 | < 5 ms; availability 99.95% |
| Publish saga success (excluding guard blocks) | > 99.5% |

### 11.2 Capacity
- **Measured today:** 130-165 submits/s per form, with a 500-1,000/s design target (fORM- arch §2.5). Two quick wins:
  - Skip the `form_counters` update when a form has no limit (DMS-linked forms rarely have one).
  - Make `forms.submission_count` asynchronous.
- **DMS path B is the ceiling.** It does a synchronous MySQL insert, ES index, audit and outbox per record.
  - Defaults: 10 concurrent per tenant, 150 rps global, tuned with the DMS team in the joint load test.
  - Per-tenant token bucket, plus a circuit breaker per (tenant, endpoint). `Retry-After` is honoured.
  - **Fair share:** projection queues are sharded `dms.project.{0..N}` by `hash(org_id)`, with a weighted round-robin claim and a per-tenant in-flight semaphore.
  - Imports run at low priority.
- **Load test (WP-1.28) before any tenant reaches `fill`:**
  - 200 submits/s sustained with synchronous projection against a DMS stub at 300 ms p95;
  - 2,000 concurrent fill sessions;
  - then a joint test against staging dms-api.

### 11.3 Data and partitioning
- RDS Postgres 18, Multi-AZ, RDS Proxy (transaction mode, compatible with transaction-local `set_config` in `withTenant`). pg-boss uses direct connections. A read replica serves exports.
- Monthly partitions:
  - Pre-create 12 months ahead.
  - Add a **default partition with an alert** (today a missed `partitions.maintain` run is a hard failure at month rollover: fORM-:packages/db/src/functions.ts:28-36).
  - `dms_projections` is partitioned the same way.
- Journal volume: about 2 KB per kind-M submission, redacted after projection `done` + 30 days.
- Growth path: `org_id` leads every key, so an org→cluster directory gives sharding and residency later.

### 11.4 Workers and processes
| Deployment | Replicas / scaling |
|---|---|
| `fr-api` | HPA on CPU and RPS, min 3, spread over AZs, PDB min 2 |
| `fr-gateway` | min 2, own HPA, independent of `fr-api` |
| `fr-worker-dms`, `fr-worker-effects`, `fr-worker-flow` | HPA on pg-boss queue depth (exported to Prometheus) |
| `fr-worker-system` | Singleton (partitions, audit) |
| `fr-dms-inbox` | 1-2 replicas (P5) |

Other settings:
- Secrets via AWS Secrets Manager CSI: `JOB_SIGNING_KEYS`, `AUTH_SECRET`, AWS KMS, app token, service tokens, ticket public key, Passport public key.
- `TRUST_PROXY` = the exact ALB hop count (fORM-:apps/api/src/config.ts:34-52).
- `EGRESS_POLICY=allowlist` with the dms-api, storage-api and workflow-api hosts. Under `open`, private ClusterIPs are denied.
- Images are multi-stage and non-root. Health checks are `/livez` and `/readyz`.

### 11.5 Observability
- OTLP traces with `traceparent` propagated to dms-api. dms-api stores it in its outbox (dms-api:app/Services/OutboxService.php:27-48), so one trace runs fORM- → DMS → Kafka → Flow+.
- Metrics: projection latency and error class, breaker state, per-org backlog, gateway decision counts (proxy vs hand-off), drift detections, guard blocks.
- Dashboards: per-tenant cutover health. Alerts on the SLOs above.

### 11.6 Disaster recovery
| Item | Target |
|---|---|
| RPO | ≤ 5 min (RDS PITR, 35-day retention) |
| RTO | ≤ 1 h (cross-AZ automatic; cross-region restore from snapshot) |

- For kind M, loss of fORM- loses only definitions and the in-flight journal. Definitions are recoverable from `form_builders.json_data`, the export kept in DMS. The DR runbook includes "re-import from DMS".
- **During a fORM- outage:** the gateway auto-falls back to PROXY to Form+ for any route whose master is still Form+-renderable. That is always true during coexistence.

## 12. Changes required in DMS repos

**P1-P2 need no DMS code changes** (infra only: ALB rules, host and WAF). Per security finding S7, D1-D3 and D9 must land before any non-internal tenant reaches `fill`.

| # | Repo | Change | Size | Phase |
|---|---|---|---|---|
| D1 | dms-api | **Internal forms API** `Route::prefix('dms/internal/v1/forms')->middleware(['throttle:internal','app.token:<perm>','resolve.app.metadata.tenant','tenant.database'])`: `POST/PATCH/GET masters[/{id}]` (thin over `MasterFormService`, guard kept, RBAC as `metadata.user_id`); `POST records` (field-id keys → names → `MasterRecordService::create`); `POST records:validate` (dry run); `GET records/{id}` (workspace-scoped, as user); `PATCH records/{id}` (`If-Match`, lock guard kept); `POST records/{id}/documents` (pull `source_url` from an allowlisted fORM- S3 host, actor from metadata, emit FileTagged). Error shape `{code,message,errors:{<fieldId>:[…]},trace_id}`. | M | P5 |
| D2 | dms-api | Idempotency: tenant table `form_record_ingest(idempotency_key varchar(128) PK, request_hash, record_id, created_at)`, inserted **in the same transaction** as the record. A replay returns 200 + `Idempotent-Replayed`; a different hash returns 422. Documents are idempotent on `(record_id, field_id, sha256)`. | S | P5 |
| D3 | dms-api | App-token hardening: store sha256 (today plaintext, app/Http/Middleware/AppTokenAuth.php:25), add `allowed_tenant_ids`, seed `form-engine` with the four permissions. | S | P5 |
| D4 | dms-api | Stable slug on rename (app/Models/FormBuilder.php:70-78), or keep old slugs resolvable. | S | P5 |
| D5 | dms-api | `masters.form_engine enum('formplus','form') default 'formplus'`, set by fORM- via the internal API. Used by D9 guards and reporting. | S | P5 |
| D6 | monorepo workflow-api | `POST /v1/internal/run-steps/:stepId/action` (service token + HMAC, `serviceCallerAuthorized:true`, idempotency, assignee check); launch-ticket mint (ES256); `assertValidWorkflowGraphTaskForm`; append `fieldUpdates` to `pending_dms_metadata_updates`. | M | P6 |
| D7 | monorepo dms-ui | Server-signed hand-off (`POST forms/v1/dms/handoffs` or a JWS route); delete `hashData.ts`. Optional. | S | P7 |
| D8 | monorepo workflow-ui (+ dms-ui panel) | Form picker, take-action iframe, read-only view iframe, Task (form variant) unhide, all behind runtime flags. | M | P6 |
| D9 | dms-api, storage-api | 410 for `form_engine='form'` masters on `createSubmission`, `form-by-slug/*/find`, `multiple-document-upload-new`; after retirement close those plus `multi-uncat-upload-new` and storage-api `*-new`. | S | P5/P7 |
| D10 | dms-api (optional) | Emit `Master/Update` → `dms.master.update` from MasterFormService and MasterService (workflow-api already subscribes). Enables event-based drift detection. | S | P6 |
| D11 | auth-frontend | Copy, branding, dead code, billing per O5. | S | P7 |

**Also raised with the DMS team (not fORM- blockers):**
- A live Passport JWT is committed as a fallback header in `monorepo:apps/frontend/workflow-ui/lib/interceptors/dms.interceptor.ts:50` and `dms-ui/lib/interceptors/dms.interceptor.ts:60`. Rotate it.
- Confirm which `outbox:publish` is live in prod (dms-api routes/console.php:45-46 is commented; auth-api routes/console.php:12 runs).
- Move the path-B outbox emit inside the record transaction (MasterRecordService.php:1339-1345).
- MSK auth.
- iam-api has no HTTP auth.
- realtime and websocket tenant isolation.
- Unauthenticated S3 presign in auth-api.
- JWKS + `kid`, short-lived tokens, refresh and revocation.

## 13. Phased roadmap

S ≤ 3 days, M ≤ 2 weeks, L ≤ 4 weeks. "Owner" is the team that does the work.

| Phase | Work packages | Size | Owner | Exit criteria |
|---|---|---|---|---|
| **P0 Foundations** | WP0a push `dev` to a private remote (owner decision; nothing pushed today) · WP0b do **not** merge `dev-lokesh`; port features per `port/lokesh-nov16`, dropping guest publish, by-form routes, `ALLOW_OPEN_ACCESS`, `submissionDelivery.ts`, migration 0016 · WP1 S3 upload + ClamAV (WP-1.14) · WP2 runtime-projection credential fix + server-side lookups and API validation · WP3 captcha/PoW (WP-1.13) · WP4 images + Helm + secrets + RDS · WP5 field encryption (WP-1.11) | S, M, M, M, S, M, L | fORM- (+infra) | fORM- runs multi-pod on staging EKS. No plaintext-answer or credential-leak findings open. Backup remote exists. |
| **P1 Gateway pass-through** | WP6 `fr-gateway` (routing, proxy, fail-open, metrics) · WP7 ALB repoint, 100% PROXY for 1 week | M, S | fORM- + infra | Zero change in error rate or latency on `/formbuilder*` versus baseline. Break-glass drill done. |
| **P2 Identity + codec + shadow** | WP8 identity bridge (exchange, `provider='dms'`, sealed JWT, role and team mapping, links) · WP9 `@form/compat-opnform` + `yes_no` block + fixtures · WP10 parity harness · WP11 `dms.import.forms` + per-tenant report | M, L, M, M | fORM- | Pilot (internal) tenant at `shadow`, ≥ 95% of masters parity-clean, report reviewed. |
| **P3 Pilot fill** | WP12 DMS client (bulkhead/breaker/TB/fair shards) + projection saga + reconcile + sync-issues UI · WP13 pre-validator + conditional-required export · WP14 record edit/read via DMS | L, M, M | fORM- | Internal tenant at `fill` for 2 weeks; `failed_terminal` < 0.1%; Flow+ triggers verified on a pilot master. |
| **P4 Pilot editor** | WP15 master editor saga (create/edit/publish, drift, guard errors, compat profile) | L | fORM- | Pilot creates and edits masters only in fORM- for 1 week; zero drift incidents; rollback drill per master and per tenant passed. |
| **P5 Harden + waves** | WP16 D1-D5, D9(410) · WP17 switch projection to the internal API; delete sealed tokens · WP18 load test WP-1.28 (stub + staging DMS) · WP19 optional Kafka inbox · WP20 tenant waves 10% → 50% → 100% | M+S (DMS), M, M, M, M | DMS + fORM- | All tenants at `full`; no user JWT stored in fORM-; SLOs met for 30 days. |
| **P6 Flow+ + rich view** | WP21 embed tickets + `/embed/records` · WP22 Flow+ form task phase 1 (D6, D8, `/flow/fill`, `flow.step.complete`, writeback/child_record) · WP23 audit forwarding · D10 | M, L, S, S | Flow+ + fORM- | A form task completes end to end in production for a pilot workflow; read-only view live in workflow-ui. |
| **P7 Retire Form+** | WP24 remove Form+ target group; close the anonymous endpoints (D9); D7, D11; licence sign-off | M | DMS + infra + legal | Form+ image gone; anonymous write routes return 404/410; counsel memo filed. |
| **P8 Extend** | WP25 DocType forms (after reading the classic frontend) · WP26 form-task phase 2 (run-data, external respondents) · WP27 `form.submission.*` producer once MSK is authenticated | L, L, M | both | Per item. |

Critical path: P0 (WP1, WP4) → P1 → P2 (WP8, WP9) → P3 (WP12) → P4 → P5 (WP16, WP17).

These can start on day 1: WP6, WP9, and the DMS team's D1-D3. The DMS items are small, and they remove the main residual risk: no idempotency during the pilot.

## 14. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Path A → B behaviour change: new Flow+ runs and record locks on create, stricter validation, share setting enforced | Per-tenant report and admin acknowledgement; `A_compat` with sunset; per-master override |
| 2 | Logic-hidden required fields and phone formats cause path-B 422s | Conditional-required export rule (F3); pre-validator; O3 decided before P3 |
| 3 | Duplicate DMS records before D2 | No blind retries; `needs_attention`; D2 prioritised for P5; pilot only before it |
| 4 | Codec fidelity on hidden or legacy types in real data | Three-gate parity harness on real exports; `flag_override`; `last_good_json` restore |
| 5 | Unknown prod routing (ALB, `/sharemaster`, `/forms`) | Infra discovery session before WP7; the gateway proxies anything it cannot classify |
| 6 | Classic DMS frontend unread (DocType flows) | Kind D always proxied; follow-up discovery in P8 |
| 7 | fORM- maturity gaps (plain answers, local disk, no Helm, no captcha, local-only `dev`) | P0 gates; journal redaction; WP-1.11 before broad rollout |
| 8 | DMS throughput and coupling | Async public projection, journal, breaker, fair shards, joint load test |
| 9 | Sealed long-lived DMS JWTs in fORM- (P1-P4) | KMS sealing, column grants, session-bound deletion, pilot tenants only, removed at P5 |
| 10 | Unauthenticated MSK | Hints only, verify-by-read, no fORM- producer |
| 11 | Two definition sources during coexistence | Drift check on open and pre-publish; one-way authority per stage; D10 later |
| 12 | Gateway becomes a shared dependency for legacy traffic | Separate Deployment, min 2, fail-open, ALB break-glass rule pre-staged |
| 13 | Licence (Form+ likely AGPL-derived, no LICENSE) | Clean-room codec and UI; counsel review of the interim period; retirement in P7 |
| 14 | DMS outbox publisher ambiguity (Flow+ triggers may not fire at all) | Verify in prod before P3; trigger end-to-end test is part of the P3 exit |
| 15 | `dev-lokesh` merged by mistake (open-access, SSRF, migration 0016 collision) | Branch protection on `dev`; port feature by feature; auth-none tripwire and migrator already fail such a merge |

## 15. Open decisions for the CTO

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| O1 | Default write path | **Path B for all tenants**; `A_compat` only by exception with ≤ 60-day sunset | Path A first for exact parity. This loses ES, audit and triggers, and keeps an anonymous route alive. |
| O2 | Evidence journal retention (kind M) | **30 days after projection, then redact**; fORM- shows no kind-M responses list | A permanent fORM- copy for analytics. It duplicates PII and needs WP-1.11 plus DSR tooling first. |
| O3 | Phone value in DMS | **E.164 digits without `+`** (passes path-B numeric check); legacy decoded on read | Ask DMS to accept `+` / `ISO2+dial` (small DMS change, nicer data) |
| O4 | Multi-select storage in DMS | **Keep comma-join in v1** (no DMS change); warn on commas in labels | DMS accepts JSON arrays (cleaner; touches reports and ES mapping) |
| O5 | Forms+ as a product and billing | **Fold into DMS+** (hide the Forms+ signup tile, clean `source='forms'` rows later) | Keep a separate SKU: needs server-side submission and storage quotas, which do not exist today |
| O6 | `forms.*` rights, external-respondent role, disputes and comments | **Retire `forms.*` for kind M** (DMS rights + fORM- roles); revisit external respondents with form-task phase 2 | Map `forms.*` onto fORM- roles now |
| O7 | dms-ui native `/sharemaster` renderer | **Keep as fallback until P7**, then redirect to fORM- | Remove at P5 |
| O8 | Standalone (kind S) forms triggering Flow+ | **Not in v1**; bind to a master if workflow is needed | Build a non-master `form.submitted` trigger (needs the P8 producer and Flow+ builder work) |
| O9 | Approvals for DMS-linked forms | **Flow+ owns approvals**; fORM- maker-checker only for kind S | Allow both (confusing double approval) |
| O10 | Host layout | **`forms.<domain>`** + gateway on DMS paths | Path on the DMS host (cookie collisions with `__Host-` and JS-readable DMS cookies) |
| O11 | Pilot tenant and wave order | Internal dMACQ tenant first, then the 3 tenants with the fewest triggered masters | — |
| O12 | DMS identity hardening (JWKS/`kid`, short TTL, refresh, revocation) | **GA blocker** (security review S8) | Request it, non-blocking |

## Appendix: evidence index

**Form+ (dmacq-form-builder @ ebc4737)**
- FB:server/tsconfig.json:1-3 (no backend) · FB:nuxt.config.ts:13-15 (base `/formbuilder/`) · FB:composables/useOpnApi.js:44 (hard-coded API host)
- FB:components/open/forms/components/FormEditor.vue:426-441, 701-717, 726-731 (save payloads, master save, return redirect)
- FB:components/open/forms/OpenCompleteForm.vue:455, 496-501, 558-561, 584-607 (submit, postMessage `"*"`, redirect, partial file failure)
- FB:lib/file-uploads.js:28-30, 55, 181, 248-285 (chunks, registration, `user_id`) · FB:lib/hashData.js:25-39 (unkeyed hash)
- FB:components/open/forms/OpenFormField.vue:471-476 (label values) · FB:components/forms/FileInput.vue:352-357 · FB:opnform.config.js:9-10, FB:app.vue:37 (provenance)

**dms-api (origin/dev 53d1fb2bb)**
- routes/api.php:210-213 (internal authz), 238-255 (app.token), 575-580 (createSubmission), 589 (doc upload new), 600-606 (public slug routes), 628/637 (auth groups), 643-648 (v1/master/form)
- app/Http/Middleware/InitializeTenantDatabase.php:143-191 · VerifyToken.php:44-77, 106-114 · AppTokenAuth.php:25
- app/Services/FormService.php:73-217, 131-213, 1126-1178, 1351-1354 · MasterFormService.php:108-110, 170-172, 602-620 · MasterWorkflowStructuralGuard.php:48-54
- app/Repositories/FormSubmissionRepository.php:33-117 · MasterRecordRepository.php:303-376, 700-715 · app/Services/MasterRecordService.php:1333, 1339-1345, 1432, 1526
- app/Services/OutboxEmitterForWorkflow.php:27-124, 1342-1384 · app/Console/Commands/WorkflowKafkaConsumer.php:56-200, 254-334
- app/Services/OutboxEventPublisher.php:53-142 · OutboxService.php:27-48 · routes/console.php:21-25, 45-46
- app/Rules/BaseFieldsValidationRule.php:67-192 · MasterFieldsValidationRule.php:73-84 · app/Http/Requests/MasterFormRequest.php:15-95
- app/Http/Controllers/Api/v1/MasterController.php:130 · app/Models/Master.php:461-464 · app/Models/FormBuilder.php:70-78 · MasterRecordController.php:195-204, 299-301
- app/Services/DocumentService.php:1034-1062 · DocumentController.php:1189-1196 · app/Services/MasterService.php:1918-1940, 2575
- app/Services/WorkflowAuthzSnapshotService.php:32-80 · app/Policies/MasterPolicy.php:161-165 · database/seeders/AuditTypeActionSeeder.php:121-143 · app/Support/FormBuilderFieldJson.php:10-22

**auth-api / auth-frontend / storage-api / others**
- auth-api:app/Services/AuthService.php:253-256, 262, 2002-2015, 2076-2077 · routes/console.php:12 · database/migrations/tenant/2026_04_20_000001_create_master_workflow_events_table.php:14-25 · database/seeders/RightsCatalogSeeder.php:56-67
- auth-fe:src/components/Cookies/setCookie.tsx:1-12 · src/app/auth/sso/callback/page.tsx:162-217 · src/utils/security.ts:202-207 · SignUp.tsx:480-489
- storage-api:routes/api.php:14-19 · app/Http/Controllers/Api/v1/MediaController.php:219-280
- reports-api:app/Services/FormService.php:142-180 · app/Notifications/SendInviteNotificationExternalUser.php:52
- realtime:src/index.ts:121-131, 328-338 · dmacq-dms-workflow-websocket:src/libs/kafka/consumer.ts:426

**monorepo (origin/dev 0e494aa2)**
- apps/frontend/dms-ui/features/metadata/components/MasterFormUI.tsx:262-313, 779-839 · utils/hashData.ts:6-33 · lib/dms-session.ts:19-21 · next.config.mjs:21, 30
- apps/frontend/dms-ui/features/metadata/main/components/Master/MasterDetailView.tsx:658-686, 949-983 · ShareMasterFullPage.tsx:188-341 · ShareMasterSidePanel.tsx:355-393
- apps/frontend/{dms-ui,workflow-ui}/lib/interceptors/dms.interceptor.ts:60 / :50 (committed JWT; path and kind only)
- infra/docker/nextjs/Dockerfile:97 (build-time env)
- apps/backend/workflow-api: kafkaClientConfig.ts:13 · kafkaTopicConfig.ts:35-50 · WorkflowRecordIngestService.ts:140-215 · dmsMetadataUpdateContract.ts:1-120 · AuthorizationMiddleware.ts:130-262 · serviceTokenAuth.ts:24-27 · WorkflowUseCases.ts:100-105, 2280-2283 · DynamicWorkflowExecutor.ts:736-746, 1028-1075, 1858-1866, 2286-2308 · controllers/workflowStepActionActor.ts:15-55 · UpdateMetadataActivities.ts:55-62
- apps/frontend/workflow-ui: workflow-builder-v1-ui-hides.ts:55-65 · node-config-field-renderer.tsx:1659 · features/workflow-instance/main/page.tsx:3918-3963
- packages/iam-contracts/src/kafka/dmsKafkaTopics.ts:22-30

**fORM- (`dev` @ bbe733ff)**
- apps/api/src/submit/pipeline.ts (submit pipeline; 31-32 captcha pending; 210-223 files) · apps/api/src/submit/live.ts:72 · apps/api/src/auth.ts:121-150 · apps/api/src/modules/auth/csrf.ts:26-58 · apps/api/src/modules/auth/sessions.ts:9-11
- apps/api/src/authz/roles.ts:25, 41-49 · apps/api/src/routes/forms.ts:174, 282 · apps/api/src/files.ts:8,14 · apps/api/src/config.ts:34-52 · apps/api/src/app.test.ts:722-756
- apps/worker/src/jobs/submission-fanout.ts:26-72 · apps/worker/src/effects/disclosure.ts · packages/ports/src/queue.ts:22-200
- packages/db/migrations/0001_foundation.sql:21-26 · 0006_auth.sql:73 · 0008_orgs.sql:158 · packages/db/src/tenant.ts:4, 57-73 · packages/db/src/migrate.ts:38 · packages/db/src/functions.ts:28-36 · packages/db/src/schema/auth.ts:6
- packages/schema/src/v2/zod/primitives.ts:16 · packages/schema/src/v2/envelope.ts:71-90 · packages/logic/src/projectForRuntime.ts:32-64
- packages/adapters/src/egress/guard.ts:110-148 · apps/builder/security/headers.ts:61 · docs/platform/03-architecture.md:545-551, 612, 1110
