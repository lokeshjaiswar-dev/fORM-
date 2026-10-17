# fORM- Templates Spec (customizable templates)

**Status:** v1.1, revised after the compliance and feasibility reviews (`05-review-log.md`). **Baseline:** commit `e1be409` (5 templates hard-coded in `src/data/templates.ts`, picked in `src/components/builder/TemplateModal.tsx`).
**Covers:** feature-matrix domain §2b "Templates (TPL)", rows TPL-01 to TPL-33. BLD-13, DSN-03 and DSN-09 are pointer rows to TPL-07/12, TPL-14 and TPL-24.
**Types:** every shape in this spec is defined in the schema (`02-form-schema-v2.md` §2, section §17). Where the two differ, the schema wins; the deltas are listed in the schema §2.1.

**What "customizable" means here.** A user can:
1. **use** any template and then change everything in the resulting form (blocks, rules, theme, emails, endings, PDFs), except regions an enterprise admin has locked (P3);
2. **fill variables** when using it (org profile, brand kit, `custom.*` prompts, optional parts), so one template produces many tailored forms;
3. **save** any form, or a selection of blocks, as their own template (personal, team or org);
4. **fork** a system template into an org template, edit it in the template builder and publish new versions, while still receiving fORM-'s upstream corrections (TPL-32);
5. **brand** every template kind through a brand kit;
6. **receive updates** from a template into their forms by choice, with a three-way diff that keeps their own edits.

---

## 0. Research: how JotForm handles templates (October 2026)

| Area | JotForm behaviour | Source | What fORM- takes from it |
|---|---|---|---|
| Form template gallery | Advertises "20,000+ free online form templates". Search box. Sort by Popular, Recent or Trend. Filter by layout (Classic or Card). About 40 "Types" categories with item counts (Order Forms 8,626; Survey 26,486; Request 13,251). An Industries facet. Each card has "Preview" and "Use Template". | https://www.jotform.com/form-templates/ | Same facet set: kind, use-case, industry, layout, language. Volume parity stays a non-goal (about 150 curated). |
| Category index | Template families: Form, Card Form, App, Sign, Workflow, AI Agent, Board, PDF, Table and Store Builder. Per-category counts disagree with the main gallery (Survey 13,566 here, 26,486 there), so counts are marketing figures. | https://www.jotform.com/form-templates/all-categories | We ship Form, Theme, Email, Ending, PDF, Snippet and Workflow. App, Table, Sign, Board, Store and AI Agent belong to non-goal products (TPL-31). |
| Gallery growth | "Jotform users create more than 200 templates each week", mostly user submissions. | https://agent.jotform.com/books/the-ultimate-guide-to-online-forms/form-basics-and-fundamentals/ | A community gallery is P4 (TPL-29), with moderation. |
| User-submitted templates | Workspace > More > "Share as Template": title, language, description, category. A red lock icon means "under review". After approval the template is public. Sharing does not change the original form. | https://www.jotform.com/answers/39694911-form-templates-how-to-share-a-form-template-with-other-jotform-users, https://www.jotform.com/answers/4764767-sharing-form-as-a-template, https://www.jotform.com/answers/1972049-how-do-i-unshare-a-template | Same metadata and review state, but inside an org (TPL-17). |
| "Use template" is a clone | Conditions and thank-you settings are copied. Help pages disagree on whether emails keep their content and whether PDFs and workflows are copied. Integrations, prefills and reports are not copied. Encryption is switched off. Submissions are never copied. Private or password-protected forms cannot be cloned; "Prevent Cloning" blocks it. | https://www.jotform.com/help/42-How-to-Clone-an-Existing-Form-from-a-URL, https://www.jotform.com/help/how-to-clone-an-existing-form-from-your-account/ | **Gap:** no lineage, so a form never hears about template updates. We keep lineage (§4) and an exact copy manifest (§3.1). |
| Enterprise org templates | Since "Enterprise 2.0": a server-wide template directory under "Templates". Admin Console > Assets > Forms > Settings > Templates has an on/off toggle and "All Users" or "Admins Only" for sharing. AI can generate a template from a prompt. No locking or branding controls are mentioned. | https://www.jotform.com/blog/ai-powered-server-wide-template-generation/, https://www.jotform.com/blog/ways-to-collaborate-with-jotform-enterprise/ | We copy the publish policy (§2.3) and add review, versions, forks and (P3) locks. |
| Theme templates | Form Designer > Themes > "Use Theme". My Themes > "Create New Theme" from a form, with title, description, custom CSS and privacy. Themes can be published publicly and **sold** in the Theme Store. | https://www.jotform.com/help/184-Changing-Themes-on-Forms, https://www.jotform.com/answers/692921-How-do-I-save-a-theme, https://jotform.com/answers/15918381-is-it-possible-to-add-my-own-theme-to-the-themes-in-form-designer, https://www.jotform.com/theme-store/theme/calm | Theme templates and saved themes are in (TPL-14). Selling is Won't (TPL-30). |
| Brand Kit (Enterprise) | AI reads a logo or website and suggests themes; an admin applies it org-wide to workspaces, login and error pages and the **default** form theme. One kit per org. Enforcement and multiple kits are not documented. | https://www.jotform.com/blog/announcing-the-brand-kit-jotform-enterprise/, https://www.jotform.com/enterprise/white-label/ | Brand kits feed every template kind (TPL-14). Enforcement and multiple kits are ours (TPL-24). |
| PDF templates | "Choose from over 1,900 templates" with a drag-and-drop editor. Every form has a default PDF. | https://www.jotform.com/products/pdf-editor/features/use-template, https://www.jotform.com/blog/announcing-600-pdf-templates/ | PDF templates are layout presets on EXP-03/EXP-05. The designer stays P4 (EXP-07). |
| App and Sign templates | Claims of 3,500+ app and 800+ Sign templates. | https://www.jotform.com/products/apps/features/data, https://www.jotform.com/products/sign/features/workflow | Out of scope. |
| Email templates | Notification and autoresponder emails are created by default and edited **per form**. Email Copilot offers rewrites. A 2022 answer says there is no reusable cross-form email template. | https://www.jotform.com/help/430-how-to-edit-the-email-template-for-notifications-and-autoresponders/, https://jotform.com/answers/4685068-is-there-a-way-to-make-a-standard-autoresponder-email-template-that-c | **Gap:** org-wide email templates (TPL-16) with a lockable legal footer (TPL-23, P3). |
| Thank-you templates | Message or redirect, with action buttons. Card forms are limited. | https://eu.jotform.com/help/499-how-to-edit-thank-you-page-settings, https://jotform.com/answers/1865967-customize-the-thank-you-page-in-card-form | Endings become a template kind (also closed, limit-reached and not-yet-open screens). |
| Governance and locks | Admins can hide gateways and widgets. **No admin lock on template fields**; support suggests workarounds. | https://jotform.com/help/how-to-change-the-allowed-payments-and-widgets-in-your-organizations-form-builder, https://www.jotform.com/blog/announcing-enterprise-customizations/, https://jotform.com/answers/1841187-how-to-lock-the-form-fields-on-edit | **Gap:** locked regions enforced on the server (TPL-23, P3). |
| Export and portability | No template file format; sharing is by clone URL. | (clone sources above) | Signed JSON bundles and on-prem packs (TPL-20, TPL-05). |
| Reusable field groups | Nothing found. | n/a | **Gap:** snippets (TPL-15), e.g. the KYC block or the DPDP Consent block. |

Caveats: counts come from JotForm marketing pages and contradict each other. Some help answers are dated (2015–2024) or AI-generated. We did not test JotForm hands-on.

**Where fORM- goes further:** lineage and opt-in updates (for forms and for forked templates), template variables from the org profile, brand kits applied to every kind, locked regions checked on the server (P3), reusable snippets, signed portable bundles that work air-gapped, and a data inventory in the preview (DPDP).

---

## 1. Template kinds

A template is a versioned, immutable payload of one `kind`. Each kind's payload is defined in `@form/schema` (`TemplateVersionPayload`), carries a `schemaVersion`, and is migrated by the same `migrate()` as forms.

| Kind | Payload (summary) | Applied by | Phase |
|---|---|---|---|
| `form` | `document`: a full `FormDefinition` (blocks, pages, rules, variables, privacy, i18n, settings). Optional `refs`: `{ theme?, endings?[], emails?[], pdf?[], workflow? }`, each a `TemplateRef` or an inline payload. `sampleAnswers` (synthetic only, never derived from real submissions). `dataInventory`. `estimatedMinutes`. `optionalParts`. | Using it creates a new form draft | P0 schema, P1 server |
| `theme` | `tokens`: colours, typography, radius, density, form width, label alignment, input style, progress style, background. `layout: 'classic' \| 'cards'`. `customCss?` (scoped under `.fr-root`, sanitised, no external `url()`; DSN-04). Colour values may be literals or brand refs (`{ref:'brand.primary'}`). | Design panel > Themes, at form creation, brand-kit default | P2 |
| `email` | `role: 'notification' \| 'autoresponder' \| 'edit_notice' \| 'invite' \| 'resume_link' \| 'otp' \| 'withdrawal_confirm' \| 'dsr_response' \| 'breach_notice' \| 'guardian_consent_request'`. `subject` (`PlainTemplate`). `body` (`EmailDoc` with `answersTable`, `button`, `brandBlock` and `var` nodes). `headerRef` / `footerRef` (brand kit). Recipients are always placeholders (`{kind:'field'}`, `{kind:'role'}`), never literal addresses. | Form > Emails > "Choose template" | P1 system defaults, P2 authored |
| `ending` | `role: 'thank_you' \| 'closed' \| 'not_yet_open' \| 'limit_reached' \| 'password' \| 'already_submitted' \| 'outside_hours'`. `content`. `actions[]`. `redirect?` (https only). Optional `confetti`. There is no `quarantined` role: spam quarantine is silent and respondents see the normal ending. | Form > Endings | P1 system defaults, P2 authored |
| `pdf` | `layout`: page size (A4 default for en-IN), orientation, margins, header and footer (logo via brand ref, `org.legal_name`, page numbers), `fields: all \| by_classification \| explicit`, `hideEmpty`, `maskSensitive`, `watermark?`, `passwordFrom?` | Form > PDFs (EXP-05) | P2 |
| `snippet` | `rootId`: one `section` block (FLD-48) with children, rules scoped to the snippet, `logicVariables`, the `purposes` its fields need, `insertHints` (preferred position, `oncePerForm`). In P1 a snippet may be a **single block** (the Consent block) with no section. | Slash menu, palette "Snippets" / "Compliance" | P1 single-block, P2 sections |
| `workflow` | WFL-01 flow definition (steps, approvers as placeholders or roles, branch conditions) | Bundled in a `form` template, or applied to a form | P2 |

Rules that apply to every kind:
- A payload holds **no secrets, no access control and no live data**: no password hash, slug, embed allowlist, integration credentials, webhook URLs, analytics IDs, submissions, or literal recipient emails. The access part of `FormOps` is excluded by type, except `access.screens` (status screens), which are templates in their own right.
- A payload is validated against the **field registry**, against **logic** (no dangling references, no cycles, page-order rule), through the **rich-text sanitiser** and the **regex safety** check, and against the compliance publish rules (notice completeness, consent before consent-based fields). This happens at save, at publish, at import and at seed.
- `requiredFeatures` hides or disables templates that the edition, plan or install cannot run (for example Google Sheets on air-gapped installs; payments on plans without payments).

---

## 2. Scopes and the publishing flow

### 2.1 Scopes

| Scope | Owner | Visible to | Written by | Storage |
|---|---|---|---|---|
| `system` | fORM- (or the platform operator on-prem) | Every org, unless the org hides the system gallery (TPL-26, P3) | Only the seed job, from a signed pack (§8), as role `fr_template_seeder` | `org_id IS NULL` |
| `org` | An organisation | All members of the org | Users the org publish policy allows (§2.3) | `org_id = X, team_id NULL` |
| `team` | A team inside an org (WSP-05, P2) | Team members, plus org admins | Team admins and creators, under the policy | `org_id = X, team_id = T` |
| `personal` | A user | That user, plus org admins for governance | The owner | `org_id = X, owner_user_id = U` |

**Forking.** An org can fork any template it can see (typically a system template) into a new `org` or `team` template. The fork records `forked_from_version_id` and a **fork binding** (`template_fork_bindings`, TPL-32), so when the upstream template publishes a new version (for example corrected DPDP consent text), the fork's owner gets the same three-way update flow that forms get (§4.4). Forking is available from P1 (TPL-08); upstream updates for forks arrive in P2 (TPL-32).

### 2.2 Lifecycles

```
template_version.state:  draft ──submit──▶ in_review ──approve──▶ published ──(newer published)──▶ superseded
                           │                   │reject
                           │                   ▼
                           │               rejected (terminal for that version; author starts a new draft, version+1)
                           └──publish directly when the policy needs no review──▶ published
template.lifecycle:      active ──deprecate──▶ deprecated (hidden from gallery, existing forms unaffected) ──archive──▶ archived ──restore──▶ active
```
- A template has at most **one** `draft` version at a time. Published, superseded and rejected versions are immutable: a DB trigger rejects any change to `payload`, `payload_hash` or `lock_fingerprints` when `state <> 'draft'`.
- Version numbers are integers. Each version carries a `changelog` (required from v2) and a `change_level: 'patch' | 'minor' | 'major'`, which the diff engine suggests.

### 2.3 Org publish policy

`org_settings.templates`:
```ts
{
  publishPolicy: 'admins_only' | 'members_direct' | 'members_with_review',  // default 'admins_only' (JotForm: "All Users" / "Admins Only")
  reviewers: { roles: ['owner','admin'], userIds: [] },                       // members_with_review only (P2)
  allowPersonal: true,
  showSystemGallery: true,           // P3 (TPL-26): false hides the fORM- library
  allowedSystemCategories: null,     // P3 (TPL-26)
  requireBrandKitOnUse: false,       // P3 (TPL-24)
  allowUnsignedImport: false,
}
```

Permissions extend the role model (architecture §2.4):

| Permission | Owner | Admin | Editor / Creator | Viewer / data roles |
|---|---|---|---|---|
| `templates.use` | ✓ | ✓ | ✓ | – |
| `templates.create_personal` | ✓ | ✓ | ✓ (if `allowPersonal`) | – |
| `templates.submit_org` / `submit_team` | ✓ | ✓ | per policy | – |
| `templates.fork` | ✓ | ✓ | per policy (same as submit) | – |
| `templates.approve` | ✓ | ✓ | if listed in reviewers | – |
| `templates.govern` (see all templates in org) | ✓ | ✓ | – | – |
| `templates.manage_categories`, `brand_kits.manage`, `org_profile.manage` | ✓ | ✓ | – | – |
| `templates.unlock` (detach locked regions, P3) | ✓ | configurable | – | – |
| `compliance.approve_notice` (CMP-24) | ✓ | ✓ | if granted | – |

Review UX (P2, TPL-17): a reviewer queue (`/templates/review`) shows a side-by-side diff against the previous version, rendered in the preview, plus the data inventory. The reviewer approves or rejects with a comment; the author is notified by email and in-app. Every transition writes an audit event (CMP-02): `template.version.submitted|approved|rejected|published`, `template.deprecated|archived|restored`, `template.forked`.

---

## 3. Customization

### 3.1 "Use" is a fork, and everything stays editable

`instantiate(version, ctx)` lives in `packages/templates-core` and is pure. It runs on the client (offline builder, preview) and on the server (authoritative result).

1. **Deep-copy** the payload. Block, page, rule and ending ids become `uuidv5(idSeed, sourceId)`, where `idSeed` is the `Idempotency-Key` of the use request, so client and server produce identical ids. **Option ids are kept** (scoped per block). Rule, variable and calculation references are remapped through an `idMap`.
2. **Keys:** template keys are kept; on a collision (only possible when inserting a snippet) a suffix is added (`pan` → `pan_2`). The `keyMap` is returned so prefill docs can be generated.
3. **Origin stamps:** every block, page, rule, variable, ending, purpose, notification and PDF gets `origin: { bindingId, sourceId }`. They are used by the diff (§4) and by locks (P3), are invisible to respondents and are removed from the runtime projection. **Duplicating or pasting a block strips its `origin`** (it is new content, not template content), so two blocks never claim the same `sourceId`.
4. **Variables:** baked or bound (§3.2). **Optional parts** are applied: a part whose `when` condition is false is removed with everything it lists.
5. **Refs:** the theme, endings, emails, PDFs and workflow referenced by the template are instantiated too, unless the user unticks them in the Use dialog. Each creates its own binding row.
6. **Assets:** template assets are referenced through the content-addressed asset store (§5.1), not copied byte-for-byte; the form gets its own reference rows, so deleting the template cannot break published forms.
7. **Lawful-basis review:** if the template declares any purpose on a legitimate-use ground, the Use dialog asks the user to confirm that ground for their organisation. Nothing is silently inherited, and the form's notice is unapproved until a user with `compliance.approve_notice` approves it (CMP-24).
8. Returns `{ definition, ops, bindings[], warnings[] }`. Example warning: "This template contains sensitive fields (PAN); encryption is on by default."

**Copy manifest:** blocks, pages, rules, variables, privacy (purposes, fiduciary defaults, children policy), behaviour, i18n, endings, status screens, emails, PDFs, theme and workflow are copied. Access control (password, schedule, limits, allowlists), integrations, webhooks, analytics IDs, prefill links and submissions are **never** copied. Encryption and PII tags **are** copied, so they are never silently switched off.

After use, the form is an ordinary draft. Every block, rule, theme token, email and ending can be edited, except locked regions (P3).

### 3.2 Template variables

Variables are a rich-text node, `{ type: 'var', attrs: { name: 'org.legal_name', fallback? } }`, or a `{ var: … }` item in a `PlainTemplate`. Builder chips show them as "Org legal name". They are allowed in labels, option text, help text, paragraphs, endings, email subjects and bodies, PDF headers and footers, and the Consent notice. Theme tokens reference brand values through `{ ref: 'brand.<token>' }`.

```ts
interface TemplateVariable {
  name: `${'org'|'brand'|'form'|'custom'}.${string}`;   // regex ^(org|brand|form|custom)\.[a-z0-9_.]+$
  source: 'org_profile' | 'brand_kit' | 'form' | 'prompt';
  type: 'text'|'rich'|'email'|'phone'|'url'|'image'|'color'|'date'|'number'|'select'|'boolean';
  label: Msg; help?: Msg;
  required: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: Msg }>;
  binding: 'live' | 'bake';   // org/brand/form default 'live'; prompt default 'bake'
}
```

**Built-in namespaces**

| Name | Source | Notes |
|---|---|---|
| `org.display_name`, `org.legal_name`, `org.cin`, `org.gstin`, `org.registered_address`, `org.website`, `org.support_email`, `org.support_phone`, `org.privacy_policy_url`, `org.terms_url`, `org.rights_url`, `org.board_complaint_info` | `org_profile` | Text fields can have per-locale values |
| `org.privacy_contact.{name,designation,email,phone,address}` | `org_profile` | DPDP s.8(9) contact. **Required** by the DPDP Consent, DSR and grievance templates; publish is blocked if empty. Appears in every rights response (Rule 9) |
| `org.dpo.{name,email,phone}` | `org_profile` | Optional: only Significant Data Fiduciaries must appoint a DPO (s.10) |
| `brand.logo`, `brand.logo_dark`, `brand.logo_square`, `brand.favicon`, `brand.primary`, `brand.secondary`, `brand.accent`, `brand.background`, `brand.surface`, `brand.text`, `brand.muted`, `brand.error`, `brand.success`, `brand.font_heading`, `brand.font_body`, `brand.radius`, `brand.email_header`, `brand.email_footer`, `brand.pdf_footer`, `brand.legal_footer` | the brand kit linked to the form (or the org default) | §3.3 |
| `form.title`, `form.owner_email`, `form.purposes`, `form.retention_days`, `form.public_url` | the form itself | `retention_days` comes from CMP-06 |
| `custom.*` | Asked for in the Use dialog | e.g. `custom.event_name`, `custom.school_name`, or a boolean that toggles an optional part |

**Resolution**
- `bake`: the value is substituted when the template is used; the result is plain text the author can edit.
- `live` (forms): the node stays in the draft, the builder and preview resolve it on the fly, and **publish resolves it into the immutable FormVersion**. `form_versions.variables_snapshot` records the values so audits can see what the respondent saw. A profile change updates drafts at once and published forms **at their next publish**; live forms never change silently. A banner shows "Org profile changed; 14 forms use it" (bulk republish job is TPL-24, P3).
- `live` (emails): emails live in FormOps, not in the FormVersion, so their variables and brand blocks are **resolved at send time**. Every `email_messages` row records `org_profile_updated_at` and the brand-kit token hash used, so the sent text is reconstructible. The email editor states this ("uses the current org profile when sent").
- Publish validation: a required variable that does not resolve returns `422 TEMPLATE_VARIABLE_UNRESOLVED { name, fixUrl: '/settings/org-profile#privacy_contact' }`.
- The respondent runtime never receives unresolved `var` nodes.

**Org profile** (P1). One row per org; it is also the data source for DPDP notices.
```sql
create table org_profiles (
  org_id uuid primary key references orgs(id),
  display_name text not null, legal_name text, cin text, gstin text,
  industry text,                                   -- drives the "Recommended" gallery sort
  registered_address jsonb, website text, support_email text, support_phone text,
  privacy_policy_url text, terms_url text, rights_url text, board_complaint_info text,
  privacy_contact jsonb, dpo jsonb,
  localized jsonb not null default '{}',           -- { "hi-IN": { "legal_name": "…", "privacy_contact.name": "…" } }
  updated_at timestamptz not null default now(), updated_by uuid
);
```

### 3.3 Brand kits

```ts
interface BrandKitTokens {
  name: string;
  logos: { primary: AssetId; dark?: AssetId; square?: AssetId; favicon?: AssetId };
  colors: { primary; secondary; accent; background; surface; text; muted; error; success };   // hex, checked for WCAG AA
  typography: { heading: FontId; body: FontId; baseSize: number };                           // self-hosted library (DSN-06), Noto Indic included
  shape: { radius: 'none'|'sm'|'md'|'lg'|'full'; density: 'compact'|'comfortable' };
  email: { header?: RichDoc; footer: RichDoc };                                               // footer may hold org.* vars
  pdf: { header?: RichDoc; footer?: RichDoc };
  legalFooter?: RichDoc;                                                                      // under submit on every form
}
```
- **P2:** one kit per org, marked as the default. **P3 (TPL-24):** several kits per team or sub-brand.
- **Precedence** when tokens are resolved: renderer defaults < theme template tokens < **brand kit** (fills every `{ref:'brand.*'}` and every token the theme leaves unset) < form-level overrides < locks (P3).
- **No kit yet (P1, or an org that never made one):** brand refs resolve to the theme's value or the renderer default, with a builder warning (`brand_ref_unresolved` is a **warning**, never an error). P1 templates can therefore carry brand refs safely.
- Applied to **every kind**: themes (tokens), emails (header and footer), endings (logo), PDFs (header, footer, logo) and the runtime (favicon, legal footer).
- The contrast check runs when the kit is saved (and in RSP-08). A failing pair warns, and blocks the save when `org_settings.brand.enforceContrast` is on.
- No AI brand extraction (it would need outbound calls). P4 may add a **local** palette extraction from an uploaded logo, which works air-gapped.

### 3.4 Locked regions (enterprise governance, P3; schema reserved in P0)

```ts
interface LockSpec {
  id: LockId;
  target:
    | { kind: 'block'; sourceId: string }                       // a block, or a section with its subtree
    | { kind: 'theme'; tokens: string[] }                       // e.g. ['colors.primary','logos.primary']
    | { kind: 'ending'; sourceId: string }
    | { kind: 'email'; sourceId: string; parts: Array<'subject'|'body'|'footer'> }
    | { kind: 'pdf'; sourceId: string; parts: Array<'header'|'footer'> }
    | { kind: 'purpose'; sourceId: string };                    // purpose text + lawful basis
  modes: Array<'content' | 'structure' | 'presence'>;
  // content   = labels, notice text, options, validation and required flag cannot change (variables still resolve)
  // structure = cannot reorder, move to another page, or regroup; children cannot be added or removed
  // presence  = cannot be deleted or hidden (including by a logic rule)
  reason: Msg;   // e.g. "Legal-approved consent text (v3, 2026-09)"
}
```
**Typical locks:** the DPDP Consent block (content and presence), consent purposes (purpose), the brand logo and primary colour (theme), the autoresponder legal footer (email footer), the declaration plus signature in a KYC snippet (content and presence).

**Enforcement (TPL-23, P3)**
1. **Builder:** locked items show a lock badge with the reason; inspector fields are read-only; delete, drag and hide are disabled; rules cannot `hide` a `presence`-locked block. The document store's command layer rejects such ops (`LockedRegionError`), which covers undo, redo and paste.
2. **Server:** `lockFingerprint(doc, binding, lock)` is the SHA-256 of the RFC 8785 canonical JSON of the locked projection (with `live` variable nodes normalised to their names), compared with `template_versions.lock_fingerprints[lockId]` on every draft PATCH (`409 LOCK_VIOLATION {lockId, path}`) and authoritatively at publish (`422`). Publish also checks presence by static analysis of every rule's hide targets.
3. **Detach:** a user with `templates.unlock` can detach one lock or the whole binding, with a reason. Audit event `template.lock.detached`; `governance = 'detached'`; the form is listed on the governance dashboard (TPL-25).
4. **Updates:** a locked region is replaced as a whole when an update is applied.

**Before P3:** consent text is still protected, by the notice approval gate (CMP-24): publishing is blocked when the notice, purposes or lawful bases differ from the last approved version. System legal-text corrections reach forms and forks through TPL-33 (P2).

---

## 4. Lineage and updates

### 4.1 Lineage
- `form_template_bindings`: one row per applied template (the form template, its theme, each snippet instance, each email, ending and PDF), with `template_id`, `template_version_id`, `instance_root_id`, `id_map`, `key_map`, `update_state` and `governance`.
- `forms.template_origin` (denormalised for the forms list): `{ templateId, versionId, name }`, shown as "From: GST Vendor Onboarding v3".
- Published `form_versions.template_lineage` copies the binding set, so it is known which template version produced each FormVersion (SOC 2 change-management evidence).
- `template_fork_bindings` (TPL-32): one row per fork, with the upstream template and version and an `id_map`.

### 4.2 Publishing new versions
An author edits the template in the template builder (the same `apps/builder` in `mode="template"`; a basic edit-and-publish path ships in P1 with TPL-08, the full builder with versions in P2 with TPL-18) and publishes `vN+1` with a changelog. The worker job `templates.update_notify` then:
- marks bindings and fork bindings on `vN` or older as `update_state = 'available'`;
- notifies form and fork owners with a digest, in-app and by email (configurable);
- counts `update_available` per template for analytics (§9).

### 4.3 Diff and opt-in update (P2, TPL-18)

`diffTemplate(base, theirs, ours, binding)` is a three-way diff sharing its engine with BLD-10.
- `base` = template vN, instantiated with the binding's id maps.
- `theirs` = template vN+1.
- `ours` = the current form draft, restricted to items whose `origin.bindingId` matches.

Changes are typed items: `block.added | block.removed | block.moved | prop.changed(path) | option.added/removed/relabelled | rule.added/removed/changed | theme.token.changed | ending/email/pdf/purpose.changed | lock.changed`, each with `conflict` (true when `ours` also changed that path). The update modal ("Update available: v3 → v4") shows the changelog, the list of changes and a before/after renderer preview per item. Per item: Accept / Keep mine. Conflicts default to "Keep mine" and are highlighted. "Accept all non-conflicting" is one click.

`POST …/apply` writes into the **draft** only, with a `draftRev` check, and moves the binding to vN+1. The live form changes only when the user publishes. A dismissed update sets `update_state = 'dismissed@<N+1>'`; the next version shows the banner again.

### 4.4 Fork updates (P2, TPL-32)
The same diff runs with `base` = the forked-from upstream version, `theirs` = the new upstream version, `ours` = the fork's current draft. Applying writes into the fork's draft; the fork author then publishes a new fork version, which in turn offers updates to forms bound to the fork.

### 4.5 System legal-text updates (P2, TPL-33) and mandatory updates (P3, TPL-25)
- **TPL-33 (P2):** when a system pack changes text in a consent or compliance snippet (for example after DPDP Board guidance), affected forms and forks get a "Legal text update available" banner and an org admin can **bulk-apply** the update into all affected drafts. The version can be marked `mandatory` with a deadline; after it, publishing a form still on the old text returns `422 TEMPLATE_UPDATE_REQUIRED`.
- **TPL-25 (P3):** the same mandatory mechanism for any org template, plus the governance dashboard.

---

## 5. Data model, API and RLS

### 5.1 Tables (Drizzle, Postgres 18)

Conventions follow the architecture §2.1 (uuidv7 ids generated in the app, `org_id` first, indexes lead with `org_id`). Corrections from the reviews are applied here: no `coalesce()` in primary keys or table constraints (unique **indexes** instead), FK cycles broken with `ALTER TABLE … ADD CONSTRAINT … DEFERRABLE INITIALLY DEFERRED`, `'cards'` for the layout, publisher-scoped slugs, terminal `rejected`.

```sql
create type template_kind  as enum ('form','theme','email','ending','pdf','snippet','workflow');
create type template_scope as enum ('system','org','team','personal');
create type template_lifecycle as enum ('active','deprecated','archived');
create type template_version_state as enum ('draft','in_review','published','rejected','superseded');

create table template_packs (                          -- created first (templates references it)
  id uuid primary key,
  org_id uuid null,                                    -- NULL = installed as system
  publisher text not null, name text not null, version text not null,
  manifest jsonb not null, manifest_hash bytea not null,
  signature_key_id text null, verification text not null check (verification in ('verified','unsigned','failed')),
  imported_by uuid null, imported_at timestamptz not null default now()
);

create table templates (
  id uuid primary key,
  org_id uuid null references orgs(id),                -- NULL = system
  team_id uuid null references teams(id),
  owner_user_id uuid null references users(id),
  scope template_scope not null,
  kind template_kind not null,
  publisher text not null default 'org',               -- system: pack publisher ('fORM-', 'acme-legal')
  slug text not null,                                  -- system: '<pack>/<slug>', stable across pack versions
  lifecycle template_lifecycle not null default 'active',
  source text not null check (source in ('system_pack','pack_import','user','clone','fork','jotform_import','ai')),
  pack_id uuid null references template_packs(id),
  forked_from_version_id uuid null,                    -- FK added below (cycle)
  current_version_id uuid null,                        -- FK added below (cycle)
  default_locale text not null default 'en-IN',
  industries text[] not null default '{}',
  tags text[] not null default '{}',
  layout text null check (layout in ('classic','cards')),
  featured boolean not null default false,
  sort_weight int not null default 0,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz null,
  constraint scope_shape check (
    (scope='system'   and org_id is null and team_id is null and owner_user_id is null) or
    (scope='org'      and org_id is not null and team_id is null) or
    (scope='team'     and org_id is not null and team_id is not null) or
    (scope='personal' and org_id is not null and owner_user_id is not null))
);
create unique index templates_slug_uq on templates
  (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), publisher, slug) where deleted_at is null;

create table template_versions (
  id uuid primary key,
  template_id uuid not null references templates(id),
  org_id uuid null,                                    -- kept equal to templates.org_id by trigger (RLS column)
  version int not null,
  state template_version_state not null default 'draft',
  schema_version int not null,
  payload jsonb not null,
  payload_hash bytea not null,                         -- sha256(JCS(payload))
  lock_fingerprints jsonb not null default '{}',
  required_features text[] not null default '{}',
  locales text[] not null default '{en-IN}',
  change_level text check (change_level in ('patch','minor','major')),
  changelog text,
  mandatory boolean not null default false, mandatory_deadline timestamptz,
  thumbnail_asset_id uuid null, preview_assets jsonb not null default '{}',
  stats_fields int, stats_pages int, est_minutes int, has_sensitive boolean,
  created_by uuid, created_at timestamptz not null default now(),
  submitted_at timestamptz, reviewed_by uuid, reviewed_at timestamptz, review_comment text,
  published_at timestamptz,
  pack_signature jsonb null,                           -- {keyId, alg, sig}
  unique (template_id, version)
);
create unique index one_draft_per_template on template_versions (template_id) where state = 'draft';
-- trigger template_versions_immutable: BEFORE UPDATE WHEN (OLD.state <> 'draft'):
--   raise if NEW.payload, payload_hash or lock_fingerprints IS DISTINCT FROM OLD; allow state 'published'→'superseded' only.
alter table templates add constraint templates_current_fk foreign key (current_version_id)
  references template_versions(id) deferrable initially deferred;
alter table templates add constraint templates_forked_fk foreign key (forked_from_version_id)
  references template_versions(id) deferrable initially deferred;

create table template_localizations (
  template_version_id uuid not null references template_versions(id),
  org_id uuid null,
  locale text not null,
  title text not null, summary text not null, description jsonb,
  field_labels text not null default '',
  search tsvector not null default ''::tsvector,       -- maintained by trigger (setweight A/B/C over unaccent(title|summary|field_labels))
  completeness numeric(5,2) not null default 100,
  primary key (template_version_id, locale)
);
create index on template_localizations using gin (search);
create index on template_localizations using gin (title gin_trgm_ops);

create table template_categories (
  id uuid primary key,
  org_id uuid null,                                    -- NULL = system taxonomy; orgs may add their own
  facet text not null check (facet in ('use_case','industry','compliance')),
  parent_id uuid null references template_categories(id),
  slug text not null, names jsonb not null,            -- {"en-IN":"KYC","hi-IN":"केवाईसी"}
  icon text, kinds template_kind[] not null default '{form}', sort int not null default 0
);
create unique index template_categories_uq on template_categories
  (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), facet, slug);
create table template_category_links (
  template_id uuid not null references templates(id), category_id uuid not null references template_categories(id),
  org_id uuid null, primary key (template_id, category_id));

create table brand_kits (
  id uuid primary key,
  org_id uuid not null references orgs(id), team_id uuid null references teams(id),
  name text not null, is_default boolean not null default false,
  tokens jsonb not null,
  updated_by uuid, updated_at timestamptz not null default now(), deleted_at timestamptz
);
create unique index one_default_kit on brand_kits
  (org_id, coalesce(team_id,'00000000-0000-0000-0000-000000000000'::uuid)) where is_default and deleted_at is null;

create table form_template_bindings (
  id uuid primary key,
  org_id uuid not null, form_id uuid not null references forms(id),
  template_id uuid not null references templates(id),
  template_version_id uuid not null references template_versions(id),
  kind template_kind not null,
  instance_root_id text null,
  id_map jsonb not null, key_map jsonb null,
  update_state text not null default 'current',        -- current | available | dismissed@<ver> | required
  governance text not null default 'bound',            -- bound | detached
  applied_by uuid, applied_at timestamptz not null default now()
);
create index on form_template_bindings (org_id, template_id, template_version_id);

create table template_fork_bindings (                  -- TPL-32
  id uuid primary key,
  org_id uuid not null,
  template_id uuid not null references templates(id),             -- the fork
  upstream_template_id uuid not null references templates(id),
  upstream_version_id uuid not null references template_versions(id),
  id_map jsonb not null,
  update_state text not null default 'current'
);

create table template_usages (                        -- append-only event log (§9), 400-day TTL
  id bigint generated always as identity primary key,
  org_id uuid not null, user_id uuid null,
  template_id uuid not null, template_version_id uuid not null,
  action text not null check (action in ('preview','use','insert','apply_theme','publish_from','update_applied','update_dismissed','detach','fork','export')),
  form_id uuid null, locale text, occurred_at timestamptz not null default now()
);
create index on template_usages using brin (occurred_at);

create table template_stats_daily (                    -- written by the worker under fr_system_agg
  id bigint generated always as identity primary key,
  template_id uuid not null, day date not null, org_id uuid null,   -- org_id NULL = cross-tenant aggregate (system templates only)
  previews int, uses int, publishes int, submissions int, updates_applied int, distinct_orgs int
);
create unique index template_stats_daily_uq on template_stats_daily
  (template_id, day, coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid));

create table template_signing_keys (                  -- trust store
  key_id text primary key, org_id uuid null, public_key bytea not null, alg text not null,   -- 'ed25519' | 'es256'
  label text, added_by uuid, revoked_at timestamptz
);
create table template_search_synonyms (org_id uuid null, term text not null, expands_to text[] not null);
create table template_search_misses (org_id uuid not null, q_norm text not null, locale text, count int not null default 1,
  last_at timestamptz not null default now(), primary key (org_id, q_norm, locale));   -- 90-day TTL

alter table forms add column template_origin jsonb, add column brand_kit_id uuid references brand_kits(id);
alter table form_versions add column template_lineage jsonb not null default '[]', add column variables_snapshot jsonb not null default '{}';
```

**Assets.** Template assets (thumbnails, images, logos) live in a **content-addressed store**: `assets(sha256, …)` rows point at objects keyed by hash, through the FND-17 storage adapter. A template version and every form instantiated from it reference the same object; references are rows, not copies, so a system image is stored once however many orgs use it. Objects referenced by a published version are immutable and are deleted only when no reference remains.

### 5.2 Row-level security

The request context sets `app.org_id`, `app.user_id`, `app.team_ids` and `app.perms` (architecture §2.2). **All policies use the null-safe helpers** `app_org()`, `app_user()`, `app_teams()` and `app_perms()`, wrapped in sub-selects so they run once per statement. `current_setting('app.user_id')::uuid` is never used directly: API-key, system and respondent actors have no user id, and a cast of `''` would raise.

```sql
alter table templates enable row level security; alter table templates force row level security;

create policy tpl_read on templates for select to fr_app using (
  deleted_at is null and (
    org_id is null                                                       -- system
    or (org_id = (select app_org()) and (
         scope = 'org'
      or (scope = 'team'     and team_id = any ((select app_teams())))
      or (scope = 'personal' and owner_user_id = (select app_user()))
      or 'templates.govern' = any ((select app_perms())) ))));
create policy tpl_write  on templates for insert to fr_app with check (org_id = (select app_org()));
create policy tpl_update on templates for update to fr_app using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy tpl_seed   on templates for all to fr_template_seeder using (org_id is null) with check (org_id is null);

create policy tv_read on template_versions for select to fr_app using (
  (org_id is null or org_id = (select app_org()))
  and exists (select 1 from templates t where t.id = template_id)       -- inherits tpl_read (scope/team/personal)
  and (state in ('published','superseded')
       or created_by = (select app_user())
       or 'templates.approve' = any ((select app_perms()))));
create policy tv_write on template_versions for insert to fr_app with check (
  org_id = (select app_org()) and exists (select 1 from templates t where t.id = template_id));
create policy tv_update on template_versions for update to fr_app using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy tv_seed on template_versions for all to fr_template_seeder using (org_id is null) with check (org_id is null);

-- Localizations and category links inherit visibility from their parent (closes the FTS leak):
create policy tl_read on template_localizations for select to fr_app using (
  exists (select 1 from template_versions v where v.id = template_version_id));          -- inherits tv_read
create policy tl_write on template_localizations for all to fr_app using (org_id = (select app_org())) with check (org_id = (select app_org()));
create policy tcl_read on template_category_links for select to fr_app using (
  exists (select 1 from templates t where t.id = template_id));                           -- inherits tpl_read
create policy tcl_write on template_category_links for all to fr_app using (org_id = (select app_org())) with check (org_id = (select app_org()));

-- brand_kits, org_profiles, form_template_bindings, template_fork_bindings, template_usages,
-- template_search_misses, template_packs (org rows): USING (org_id = (select app_org())).
-- template_categories, template_signing_keys, template_search_synonyms: read org_id IS NULL OR org_id = app_org(); write org rows only.
-- template_stats_daily: read (org_id = app_org()) OR (org_id IS NULL AND template is system AND distinct_orgs >= 5);
--   written only by the fr_system_agg role (architecture §2.1).
```

Bindings can point at a template that was later soft-deleted. Diffs and lineage views read such templates through the `SECURITY DEFINER` function `template_for_binding(binding_id)`, which checks that the binding belongs to `app_org()` and returns the version payload even when `deleted_at` is set.

**Isolation tests (Testcontainers, TPL-04).** For every actor kind (user, API key, system job, respondent, seeder): org A cannot list, read, search (FTS over localizations), use, diff, fork or export org B's templates, versions, localizations, category links, kits or bindings; personal templates are invisible to peers; drafts are invisible to non-reviewers; normal roles cannot write system rows; a template from another org returns 404, not 403; no policy raises for an actor without a user id.

### 5.3 API routes (Fastify 5 + fastify-type-provider-zod; the `/v1` shape also becomes the public API, INT-02)

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /v1/templates` | Gallery list | `kind, scope, category, industry, compliance, locale, layout, features, q, sort=recommended\|popular\|newest\|az, cursor`. Returns localised cards |
| `GET /v1/templates/:id` | Detail | Current version metadata and the data inventory |
| `GET /v1/templates/:id/versions`, `GET …/versions/:ver` | Versions and payload | Payload only for published versions or authorised drafts |
| `GET /v1/templates/:id/preview?ver&locale&brandKitId` | Render-ready resolved document for `packages/renderer` in `mode="preview"` | Missing variables fall back to `fallback` or sample text, marked in the response |
| `POST /v1/templates/:id/use` | Create a form from the template | Body `{ title, teamId?, locale, extraLocales[], brandKitId?, variables{custom.*}, include{theme,emails,endings,pdf,workflow}, lawfulBasisConfirmed[] }`. `Idempotency-Key` required (it is the `idSeed`). Returns `{ formId, draftRev, warnings[] }` |
| `POST /v1/forms/:formId/snippets` | Insert a snippet | `{ templateId, ver?, position: { pageId, afterBlockId? }, variables, draftRev }` → `{ ops[], keyMap, draftRev }`. **P1:** single-block snippets (Consent); P2: section snippets |
| `POST /v1/forms/:formId/apply/:kind` | Apply a theme, email, ending or PDF template | `{ templateId, ver?, role?, draftRev }` |
| `POST /v1/templates` | Create a template | `{ kind, scope, teamId?, from: { formId } \| { formId, blockIds[] } \| { blank: true } \| { forkVersionId } }`. Runs the **Save-as-template sanitiser**. `forkVersionId` writes a fork binding |
| `PATCH /v1/templates/:id` | Edit metadata | Categories, industries, tags, localisations |
| `PUT /v1/templates/:id/draft` | Save the draft payload | `draftRev` check |
| `POST /v1/templates/:id/versions/:ver/submit` · `/approve` · `/reject` · `/publish` | Lifecycle | Policy-checked (§2.3) and audited |
| `POST /v1/templates/:id/deprecate` · `/archive` · `/restore`; `DELETE /v1/templates/:id` | Lifecycle | Delete is soft; refused if bindings exist unless `?force` (bindings keep working: payloads are copied and assets referenced) |
| `GET /v1/forms/:formId/template-bindings` | Lineage and update state | |
| `GET /v1/forms/:formId/template-bindings/:bid/diff?to=ver` | Three-way diff | |
| `POST /v1/forms/:formId/template-bindings/:bid/apply` | Apply an update | `{ to, decisions: [{ changeId, choice }], draftRev }` |
| `POST …/:bid/dismiss` · `POST …/:bid/detach` | Dismiss or detach | Detach needs `{ reason }` and `templates.unlock` when locks exist |
| `GET /v1/templates/:id/fork-binding` · `…/fork-binding/diff?to=ver` · `POST …/fork-binding/apply` | Fork updates (TPL-32) | Same shapes as form bindings |
| `POST /v1/legal-text-updates/:updateId/apply-bulk` | Bulk apply a system legal-text update into drafts (TPL-33) | `{ formIds?: 'all_affected' }`; job; per-form report |
| `GET /v1/template-categories` · `POST/PATCH/DELETE /v1/template-categories/:id` | Taxonomy | Writes are org-scoped only |
| `GET/POST /v1/brand-kits`, `PATCH/DELETE /v1/brand-kits/:id`, `POST /v1/brand-kits/:id/default` | Brand kits | |
| `GET/PUT /v1/org/profile` | Org profile | Audited; responds with a count of affected forms |
| `GET/PUT /v1/org/settings/templates` | Publish policy | |
| `GET /v1/templates/review-queue` | Reviewer inbox | P2 |
| `GET /v1/templates/:id/stats?from&to` · `GET /v1/templates/stats/library` | Analytics | |
| `POST /v1/template-exports` → `GET /v1/template-exports/:jobId` | Bundle export (worker) | Signed download URL |
| `POST /v1/template-imports` (multipart) → `GET /v1/template-imports/:jobId` | Bundle import | Report: created, updated, skipped, errors |
| `GET/POST/DELETE /v1/template-signing-keys` | Org trust store | Admin only |

Errors (RFC 9457 problem+json): `409 DRAFT_REV_CONFLICT`, `409 LOCK_VIOLATION`, `422 TEMPLATE_VARIABLE_UNRESOLVED`, `422 TEMPLATE_FEATURE_UNAVAILABLE {feature}`, `422 TEMPLATE_UPDATE_REQUIRED`, `422 TEMPLATE_INVALID {issues[]}`.

Audit (CMP-02): `template.created`, `template.forked`, `template.version.*`, `template.used`, `template.snippet.inserted`, `template.update.applied|dismissed`, `template.lock.violation_rejected`, `template.lock.detached`, `template.exported`, `template.pack.imported`, `brand_kit.*`, `org_profile.updated`.

**Save-as-template sanitiser** (server-side, `packages/templates-core/sanitize.ts`):
- strips access control, schedule, limits, integrations, webhooks and **analytics IDs** (`behavior.analytics`);
- drops `sampleAnswers` unless they are explicitly marked synthetic by the author (never derived from submissions);
- replaces literal recipient emails with placeholders and flags them;
- scans default values, hidden-field defaults, paragraph text, option text and email bodies for PII patterns (email, +91 phone, PAN, Aadhaar, GSTIN) and **blocks** the save until each hit is cleared or acknowledged;
- references assets through the content-addressed store;
- recomputes PII tags, taint and the data inventory.

---

## 6. Gallery UX

### 6.1 Entry points
- **New form** dialog: *Blank* · *From template* (gallery) · *Import* (BLD-15). Replaces `TemplateModal.tsx`.
- **Templates** page in the workspace nav: *fORM- library* · *Our org* · *Team* (P2) · *Mine* · *Review queue* (P2, reviewers only) · *Brand kits* (P2).
- **In the builder:**
  - palette "Compliance" entries (P1: DPDP Consent, guardian consent, terms) and "Snippets" (P2), plus the slash menu;
  - Design panel > Themes (P2);
  - Emails, Endings and PDFs > "Choose template";
  - Form menu > "Save as template…" (P1) and "Save selection as snippet…" (P2).
- **On a template card:** *Use*, *Preview*, *Fork to org* (P1, if permitted), *Edit* (own templates).

### 6.2 Gallery layout
- **Facets** (P1 has kind, source, use case and search; the rest arrive with TPL-13 in P2):
  - Kind; Source (Recommended for your org · Org · Team · Mine · fORM- library);
  - **Use case** (Registration, Application, Onboarding, KYC & verification, Consent, Feedback & survey, Order & payment, Booking, Request & complaint, Quiz, HR, Compliance & privacy);
  - **Industry** (Banking & NBFC, Insurance, Fintech, Education (school), Higher education, Healthcare & clinics, Government & PSU, Manufacturing & supply chain, Retail & e-commerce, Real estate & RWA, NGO & non-profit, Hospitality & events, IT/ITES, Professional services, Logistics);
  - **Compliance** badges (DPDP-ready, Contains sensitive data, Children's data, GST); Language; Layout; Features.
- **Search:** Postgres FTS over title (A), summary (B) and field labels (C) with `pg_trgm` fallback (the `simple` config: Postgres has no Hindi stemmer); curated synonyms (`kyc ↔ know your customer ↔ केवाईसी`, `gst ↔ vendor registration`, `admission ↔ enrolment`); zero-result searches logged (normalised, org-scoped, 90-day TTL).
- **Sort:** *Recommended* (org templates first, then the org's industry from `org_profiles.industry`, then popularity); *Popular* (uses in the last 90 days; system templates counted across tenants only when **at least 5 distinct orgs** used them); *Newest*; *A–Z*.
- **Card:** thumbnail, title, one-line summary, badges, "12 fields · ~4 min", languages, scope chip, "Updated v4" when bound forms exist. **P1 thumbnails:** system templates get CI-rendered thumbnails; org templates get a generated placeholder (kind icon + brand colour + title) until the worker thumbnail job lands in P2 (TPL-13).

### 6.3 Preview (full-screen)
- Runs the **real** `packages/renderer` in `mode="preview"` with live logic, page navigation and device frames (BLD-11). Fill-test mode, no submit.
- Controls: language switcher, brand-kit picker (P2), theme switcher (P2).
- Tabs: **Form** · **Endings** · **Emails** (with synthetic sample answers) · **PDF** (P2) · **Data inventory** (each field's PII class, purposes, lawful basis, suggested retention, encryption) · **Changelog**.
- **Use template** dialog: title, team, primary and extra languages, brand kit, custom variables and optional parts (form generated from `variables` and `optionalParts`), lawful-basis confirmations, checkboxes for the bundled theme, emails, endings, PDF and workflow. Missing org-profile variables show an inline "Fill now" link (use is not blocked; publish is).

### 6.4 System catalogue

**P1 set (TPL-09, TPL-10; about 25 templates, only P1 field types).** P1 variants avoid P2 features: identity confirmation is a signed email link (no OTP), references use the submission id (no unique-ID field), and approval steps are absent.

| # | Template | Kind |
|---|---|---|
| 1–5 | Contact, feedback, NPS, job application, event registration (ported from `src/data/templates.ts`) | form |
| 6–10 | RSVP, volunteer sign-up, newsletter signup with consent, training feedback, IT helpdesk request | form |
| 11–14 | Leave request, expense claim (single-line items), product return, bug report | form |
| 15 | DPDP Consent block (single-block snippet: notice from `org.*` and `form.purposes`, separate unbundled items, withdrawal and rights text, language picker) | snippet |
| 16 | Guardian consent block (age gate + guardian details + verification method) | snippet |
| 17 | Terms acceptance (FLD-36) | snippet |
| 18 | Data-principal rights request (access, correction, erasure, nomination, grievance; signed-link identity confirmation; feeds the CMP-10 intake) | form |
| 19 | Grievance redressal (P1 variant: reference = submission id; ending shows privacy contact) | form |
| 20 | Consent withdrawal request (for principals without the link) | form |
| 21 | Nomination of a representative (DPDP s.14) | form |
| 22 | Data-breach intake (internal, for the Fiduciary's staff) | form |
| 23 | Default emails: notification, autoresponder (with withdrawal link), edit notice, invite, DSR response, guardian consent request | email |
| 24 | Default endings and status screens: thank-you, closed, not yet open, limit reached, password, already submitted | ending |
| 25 | Basic themes: neutral and high-contrast (theme kind ships in P2; in P1 these are theme presets of the renderer) | — |

**P2 target (TPL-12, about 150 forms + about 30 snippets + about 20 themes).**

*Generic (about 60):* order form, donation, quiz, appointment request, course evaluation, and the rest of the long tail.

*India-specific (about 60 forms):*

| Industry | Templates (main snippets and fields) |
|---|---|
| BFSI / KYC | Individual KYC (name, DOB, PAN, **Aadhaar last 4 digits only**, address with state/UT and PIN, address-proof upload with a "mask Aadhaar on copies" instruction, photo, declaration and signature) · Re-KYC · Business KYC / KYB (entity type, CIN/LLPIN, PAN, GSTIN, authorised signatory, board resolution upload) · Loan enquiry · Insurance claim intimation · Nominee registration. KYC templates carry `retention: { kind: 'statutory', years: 5, citation: 'PMLA / RBI KYC MD' }` (counsel to confirm) |
| GST and vendors | **GST vendor onboarding** (legal and trade name, GSTIN checked against PAN, Udyam number, bank details with IFSC and account confirmation, cancelled-cheque upload, TDS section) · Vendor bank-detail change · Purchase requisition · Invoice dispute |
| Education | **School admission** (student, parents or guardians, previous school, TC and birth-certificate uploads, category or RTE quota, transport). Uses `ChildrenDataPolicy { mode: 'age_gate', subject: 'subject_of_form' }` with guardian consent, or the `exempt` mode when the school relies on a Fourth Schedule exemption · College admission · Scholarship · Fee payment (Razorpay) · PTM booking · Alumni |
| Healthcare | **Patient registration** (demographics, ABHA number optional, emergency contact, allergies as sensitive, insurance or TPA, consent to treatment) · Telemedicine consent · Appointment booking · Lab-report request · Patient feedback |
| HR | **Employee onboarding** (PAN, UAN/EPF, ESIC, bank, nominee, emergency contact, uploads, BGV consent; purposes on the `s7i_employment` ground where applicable) · BGV consent · Exit interview · Leave and WFH · Internal job posting · POSH complaint (sensitive, restricted access) |
| Grievance and service | Grievance redressal (full: unique ticket ID FLD-32, OTP), consumer complaint, RTI-style request, service request, RWA complaint |
| DPDP compliance | Full DSR request with OTP (SPM-04) and the CMP-10 tracker · Verifiable parental consent with DigiLocker option (CMP-22, SaaS) · Consent withdrawal · Nomination · Breach intake |
| Government / NGO | CSR grant application · Beneficiary registration · Donation with 80G receipt · Volunteer registration |

*Snippets (about 30):* Indian address · Full name · Phone +91 · Email with confirmation · PAN · GSTIN + legal name · Bank account · KYC uploads · Nominee · Emergency contact · Guardian details · DPDP Consent · Parental consent · Marketing opt-in · Declaration + signature · Terms · Payment summary · Quiz-score ending.

*Themes (about 20):* neutral, corporate, government (GIGW-friendly, high contrast), education, healthcare, festive, dark, card-minimal, two AAA high-contrast themes. All use brand refs.

*Emails and endings:* per role, Default, Formal, Minimal and Bilingual (English + Hindi).

**Guidance notes.** Every DPDP and KYC template carries a visible note: "Template text is guidance; your organisation (the Data Fiduciary) is responsible for the final notice. Review with counsel." Templates with a signature carry: "A drawn or typed signature is not an electronic signature under IT Act s.3A; documents in the IT Act First Schedule cannot be signed this way." Legal text in system templates is versioned; changes go out through TPL-33.

---

## 7. Template i18n

- **One template, many locales.** The payload carries `i18n: { defaultLocale, locales, messages }`, the same shape as forms (RSP-05), so `use` copies translations into the form.
- **Gallery metadata** (title, summary, description) lives in `template_localizations`; category names in `names`. Fallback: requested locale → template `defaultLocale` → `en-IN`.
- **Completeness** per locale is computed at publish and shown in the gallery ("हिन्दी 100% · தமிழ் 82%"). Gaps fall back to English in the preview, highlighted.
- **Pipes and variables in translations** are carried as placeholders (`<ph>` in XLIFF); a translation must keep the same placeholder set as the source or it is rejected.
- **Variables:** org-profile text resolves per locale (`org_profiles.localized`).
- **Formatting:** FND-12 ICU (en-IN lakh/crore grouping, DD-MM-YYYY), RTL (Urdu), self-hosted Noto (DSN-06).
- **Consent notices (CMP-04):** DPDP s.5(3) and s.6(3) give the **data principal** the option to read the notice in English or any Eighth Schedule language, so every `dpdp` notice shows a language picker. System content plan:
  - P1: `en-IN` and `hi-IN` for the Consent, guardian and DSR snippets, plus a "request this notice in another language" workflow that reaches the Fiduciary as a CMP-10 intake item;
  - P2 week 4: the Consent notice in all 22 Eighth Schedule languages, with signed reviewer attestations in the pack so customer forms are not blocked by `reviewedConsentLocales`;
  - P2: `hi-IN` for the top 30 templates (TPL-19). Other templates in `en-IN`, translatable by the org.
- **Translation workflow:** a "Languages" tab in the template builder exports and imports XLIFF 2.0 or CSV, offline-friendly. Machine translation stays P4 (RSP-07).

---

## 8. Import, export and on-prem packs

### 8.1 Bundle format (`.formpack`, a zip)
```
manifest.json         { "format": "fORM-template-bundle", "formatVersion": 1,
                        "pack": { "publisher": "fORM-", "name": "system-core", "version": "2026.10.0" },
                        "minAppVersion": "1.4.0", "schemaVersion": 2,
                        "templates": [ { "slug": "india/gst-vendor-onboarding", "kind": "form", "version": 4,
                                         "path": "templates/gst-vendor-onboarding.v4.json", "sha256": "…",
                                         "requiredFeatures": ["field:address","field:file_upload"],
                                         "dependsOn": ["india/snippet-bank-account@2","core/theme-corporate@1"] } ],
                        "categories": "categories.json",
                        "attestations": "attestations.json",
                        "assets": [ { "path": "assets/9f…png", "sha256": "…", "mime": "image/png", "bytes": 48213 } ] }
templates/*.json      payload + localisations + category slugs + changelog
categories.json
attestations.json     per template and locale: reviewer, date, scope ("consent notice hi-IN reviewed by …")
assets/*
signature.json        { "alg": "ed25519" | "es256", "keyId": "fORM-release-2026", "sig": base64(sign(JCS(manifest.json))) }
```
- The manifest lists the SHA-256 of every file, so one signature covers the bundle. The algorithm is per key id: Ed25519 by default, ES256 where the signing KMS cannot do Ed25519 (for example Azure Key Vault).
- **Export** (worker job): one template, a selection or the whole org library, always with dependencies. "Generalise org values" turns baked org values back into `var` nodes. Signed with the org's signing key if configured, else unsigned. Audited.
- **Import** (worker job):
  1. Size cap 200 MB, at most 2,000 files, zip-slip and absolute-path rejection, decompression-ratio cap, sniffed MIME must match.
  2. Verify the signature against `template_signing_keys`. Unsigned bundles only if `allowUnsignedImport`, and they always land as `draft` versions needing review.
  3. `migrate()` to the current schema, then full validation (registry, logic, sanitiser, regex, compliance publish rules, `requiredFeatures` against the edition).
  4. Upsert by `(publisher, slug)`. Same hash → skipped. Newer version → `vN+1` and the update flow (§4.2).
  5. Report: created, updated, skipped, failed, with reasons.
- **Cross-product import:** the BLD-15 importer (JotForm, Google Forms, CSV of questions) can save its output as an org template.

### 8.2 System packs and on-prem / air-gapped
- Source of truth: `packages/templates/src/**`, authored as data (**not** built by calling `createBlock` at import time). CI runs `pnpm templates:build`: validate, render thumbnails (renderer + Playwright), produce `system-core-<ver>.formpack` signed with the release key held in CI KMS (dev key in P0).
- The pack is baked into the `fr-server` image (`/opt/form/packs/`) and the air-gapped bundle. On boot and upgrade, the worker job `templates.seed` (role `fr_template_seeder`) verifies and upserts it. **No network access is needed.**
- Helm values:
  ```yaml
  templates:
    seedSystemPacks: true
    extraPacks: [ { configMap: industry-bfsi-pack } ]   # or a PVC path
    trustedKeys: [ { keyId: acme-legal-2026, alg: ed25519, publicKey: "…" } ]
    showSystemGallery: true
  ```
- CLI: `form-admin templates import --pack ./bfsi-india-2026.10.formpack [--as system|--org <id>]` and `form-admin templates export --org <id> --out lib.formpack`.
- **Industry packs** (BFSI India, Healthcare India, Education India, Government) are separate signed packs, enabled per plan on SaaS and shipped as files on-prem.

---

## 9. Template analytics

- **Events** in `template_usages`: `preview`, `use`, `insert`, `apply_theme`, `publish_from`, `update_applied`, `update_dismissed`, `detach`, `fork`, `export`.
- **Daily rollup** (`templates.stats`, pg-boss cron, role `fr_system_agg` for cross-tenant system rows): previews, uses, publishes, submissions on bound forms (counts only), distinct orgs; *preview→use* and *use→publish* conversion; median completion rate of bound forms; update adoption.
- **Org library dashboard** (`/templates?tab=insights`, P2): top templates, unused templates (90 days), forms behind on updates, detached forms (P3), zero-result searches.
- **Author view:** chart per version and the list of bound forms, limited by RLS.
- **Privacy:** no respondent data. Cross-tenant system-template counts are published only when **≥ 5 distinct orgs** contributed. The platform is a Data Fiduciary for these usage events about its own users (CMP-21), and the DPA covers anonymised aggregates. On-prem keeps counts local; **nothing phones home**.

---

## 10. Phase placement and work packages

### 10.1 Matrix rows
The TPL rows (TPL-01 to TPL-33) are in the feature matrix §2b. Counted: P0 3, P1 8, P2 13, P3 5, P4 2, Won't 2 (33 rows). Non-goal 2 (template volume parity) stands.

### 10.2 Work packages
Sizes and dependencies are in the delivery plan (`04-delivery-plan.md`); this list is the scope.

**P0 (foundation; the builder keeps working offline)**
- **WP-T0.1 Schemas** (TPL-01): payload types and zod twins for the 7 kinds; `TemplateVariable`, `LockSpec`, `TemplateRef`, `TemplateForkBinding`; the `var` node in the rich-text schema; `origin` fields; `migrate()` hooks. *Done when:* round-trip tests pass and the 5 current templates validate.
- **WP-T0.2 Engine** (TPL-03): `packages/templates-core` with `instantiate`, `insertSnippet`, `resolveVariables(bake)`, optional parts, `lockFingerprint` (implemented, not enforced) and the pure parts of `sanitizeForTemplate`. Property tests: instances validate, no dangling references, deterministic ids (node and browsers), disjoint ids for different seeds.
- **WP-T0.3 System source and pack** (TPL-02): `packages/templates` with `templates:build`, validation, Ed25519 dev signing. Port contact, feedback, event, NPS and job. `TemplateModal` reads the pack through `instantiate()`; `src/data/templates.ts` is deleted.

**P1 (SaaS MVP and on-prem v1)**
- **WP-T1.1 Storage and RLS** (TPL-04): §5.1 migrations, §5.2 policies (null-safe, localizations, category links), immutability trigger, `template_for_binding()`, isolation suite per actor kind.
- **WP-T1.2 Seeding** (TPL-05): `templates.seed` job as `fr_template_seeder`, trust store, Helm values, `form-admin templates import`, air-gapped smoke test with egress blocked.
- **WP-T1.3 Org profile and variables** (TPL-06): `org_profiles` API and settings UI (incl. privacy contact, rights and Board text), live variables in builder and preview, `variables_snapshot` at publish, `TEMPLATE_VARIABLE_UNRESOLVED`.
- **WP-T1.4 API and gallery v1** (TPL-07): list, get, preview, idempotent use with lawful-basis confirmation; bindings; "From template" chip; New-form gallery; preview modal (Form, Endings, Data inventory); Use dialog (variables only for system templates in P1); **single-block snippet insertion** from the palette "Compliance" entries; placeholder thumbnails for org templates.
- **WP-T1.5 Save, fork and edit** (TPL-08): server sanitiser; personal and org scope under `admins_only` / `members_direct`; **fork a system template**; open an org template, edit its payload in a basic template editor and publish vN (no update propagation yet); lifecycle actions; metadata and category editor.
- **WP-T1.6 Defaults and compliance starter set** (TPL-09, TPL-10): the P1 set in §6.4 with legal review.
- **WP-T1.7 Usage and audit** (TPL-11): events, rollup, popularity (≥ 5 distinct orgs), audit events.

**P2 (feature match)**
- **WP-T2.1 Catalogue** (TPL-12) · **WP-T2.2 Gallery at scale** (TPL-13) · **WP-T2.3 Themes and brand kit v1** (TPL-14) · **WP-T2.4 Section snippets** (TPL-15) · **WP-T2.5 Authored email, ending, PDF and workflow templates** (TPL-16, TPL-22) · **WP-T2.6 Team scope and review** (TPL-17) · **WP-T2.7 Versions, updates, fork updates, variable and optional-part editor** (TPL-18, TPL-32) · **WP-T2.8 Template i18n** (TPL-19) · **WP-T2.9 Bundles** (TPL-20) · **WP-T2.10 Analytics UI** (TPL-21) · **WP-T2.11 System legal-text updates** (TPL-33).

**P3 (enterprise governance):** WP-T3.1 Locks (TPL-23) · WP-T3.2 Brand governance (TPL-24) · WP-T3.3 Mandatory updates and governance dashboard (TPL-25) · WP-T3.4 Gallery governance (TPL-26) and publisher trust / industry packs (TPL-27).

**P4:** TPL-28 (AI generation through the AI-01 adapter, local models on-prem) and TPL-29 (moderated community gallery, SaaS only).

### 10.3 Dependency notes
- P0 template work must land **before WP-1.06** swaps the builder's persistence adapter to the API, so the New-form flow calls `instantiate()` both offline and through the API.
- Locks (P3) rely on origin stamps (P0) and bindings (P1). Forms created in P1 or P2 can take on locks later without data migration.
- Consent-block versioning (CMP-04) and template versioning share the notice-version concept. A Consent snippet update publishes a new notice version, and consent records cite it.
- The P1 starter set depends only on P1 rows: CMP-04/05/10/13, NOT-02/03, END-01, ACC-01–04. The OTP, unique-ID and DigiLocker variants wait for SPM-04, FLD-32 and CMP-22 in P2.
