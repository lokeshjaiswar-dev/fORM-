# Contributing to fORM-

This is the practical guide to working in this repo day to day: how we branch, what to run before you push, and the handful of rules that keep a multi-tenant, DPDP- and SOC 2-bound product safe. None of it is ceremony. Each rule is here because skipping it has cost us time before. If something here is unclear or seems wrong, ask: that is always quicker than guessing.

The plan behind the code lives in [`docs/platform/`](docs/platform/README.md). Setup and commands are in the [README](README.md).

## 1. Branches

We keep two long-lived branches:

| Branch | Who writes to it | What it means |
|---|---|---|
| `main` | Maintainers only | Stable. A maintainer moves it forward from a green `dev`. |
| `dev` | Everyone | Integration. It should always install, build and pass its checks. |

The daily loop:

```sh
git switch dev
git pull --rebase origin dev        # start from the latest dev
# ...make one logical change, commit it, repeat...
git pull --rebase origin dev        # pick up anything that landed meanwhile
# run the checks in section 2; fix anything red
git push origin dev
```

- Keep commits small: one logical change each. Several small commits are easier to review, revert and bisect than one large one.
- Rebase, don't merge: `git pull --rebase` keeps `dev` linear. Never force-push `dev`.
- If the push is rejected because `dev` moved, pull with rebase again and re-run the checks. Something new came in, and it may interact with your change.
- For a change that needs review (section 8), push a short-lived branch, open a pull request into `dev`, and delete the branch once it is merged. Personal long-lived branches are not used.

## 2. Before every push: the checks

Run these from the repo root. CI runs the same commands, so if they pass locally CI should pass too.

| Command | What it catches |
|---|---|
| `pnpm lint` | Lint errors (oxlint) |
| `pnpm typecheck` | Type errors in every package |
| `pnpm test` | Unit and component tests, coverage floors, the guards in section 6 |
| `pnpm i18n:extract --check` | User-facing strings missing from the `en-IN` catalogue |
| `pnpm build` | Anything that only breaks in a production build |
| `pnpm test:int` | **When you touch `apps/api`, `apps/worker` or `packages/db`:** migrations, RLS isolation and the API against a real Postgres (needs Docker) |

Also worth running when you touch the relevant code: `pnpm test:determinism` (logic, validation, templates, i18n), `pnpm e2e` (builder flows), `pnpm deps` (imports across packages).

### Why a red CI stops the line

CI is the only shared signal that `dev` is safe to build on. Once it is red, nobody can tell whether *their* change broke something, so new failures hide behind old ones and pile up.

That is not hypothetical. This autumn the CI workflow file picked up an invisible control character, GitHub could not parse it, and CI quietly stopped running for weeks. By the time anyone noticed, type-checking failed in 16 of 17 packages and 27 unit tests were red, including the determinism tests. Each failure was small; together they took days to unpick.

So:

- After you push, check that CI actually ran (the Actions tab, or the tick next to your commit). No tick at all is as bad as a red one.
- If CI on `dev` is red, fixing it comes before any new feature. If your commit broke it, fix or revert it straight away. If you cannot, say so in the team chat so nobody builds on top of it.

## 3. Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, then a body that says **why**.

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`.
- **Scope:** the package or app, e.g. `api`, `builder`, `schema`, `db`, `renderer`.
- **Summary:** imperative, lower case, under about 70 characters: "add", not "added".
- **Body:** the reason, what changes for users or for the next developer, and the WP it belongs to (`WP-1.12`).

Not helpful: the reader learns nothing, and `git log` becomes useless.

```
upodate
```

Helpful: anyone reading the history later knows what changed, why, and where it fits in the plan.

```
fix(api): stop serving submissions to anonymous callers

The public route returned every submission for a form id without a
session, so anyone who learnt the id could read the answers. Reads
now need a signed-in member and run inside withTenant, so RLS limits
them to the caller's org. Part of the WP-1.12 hardening.
```

If a summary needs "and", or the commit touches 30 files across five features, it is several commits. `git add -p` lets you stage part of a file.

## 4. Never commit generated files

Generated files make diffs unreadable, bloat the repo for everyone, and can leak secrets. Keep these out of commits:

- `node_modules/`, `dist/`, `coverage/`, `.turbo/`, `playwright-report/`, `test-results/`
- the pnpm content store (`.pnpm-store/`). It belongs outside the repo; `pnpm store path` shows where yours is. If it appears inside the repo, a relative `store-dir` is set somewhere: remove that setting.
- `.env`, `.env.local` and anything else with keys or passwords; `.data/` (dev keyfiles and the local object store)

Before every commit:

```sh
git status                    # anything unexpected? stop and look
git add <the files you mean>  # prefer explicit paths, or git add -p, over git add .
git diff --cached --stat      # what is about to go in; hundreds of files means stop
```

If a generated folder shows up as untracked, add it to `.gitignore` in its own commit. If one was committed by mistake, `git rm -r --cached <dir>`, add it to `.gitignore`, and commit both together. CI runs gitleaks, but don't rely on it to catch secrets.

## 5. Security rules for this codebase

This is a multi-tenant product that holds other people's personal data, so a small shortcut can expose every customer at once. These rules cover the mistakes we actually see.

1. **`auth: 'none'` means public to the whole internet.** Any route with it needs a review before it lands. Ask yourself what a stranger with `curl` and a guessed id can do. A public "list submissions for this form id" route hands every answer of every form to anyone.
2. **Never trust ids, types or amounts from the client.** The server generates ids (UUIDv7). File types are sniffed on the server and files are served with that type, never the one the uploader sent; otherwise an "image" can be an HTML page running script on our domain. Totals, prices, hidden answers and "which org" are recomputed or derived on the server.
3. **Reads and writes go through `withTenant` and RLS.** The org comes from the caller's membership (the session and `X-FR-Org`, checked by `membership_for()`), never from the request body and never chosen by the server ("file it under the first active org"). Never use the migrator or admin connection in a request handler.
4. **Never edit an applied migration.** Once a migration is on `dev`, other databases have run it: an edit never re-runs there and leaves environments that disagree. Write a new numbered migration instead. Every new table needs RLS, an entry in the isolation suite for every actor kind, and an erase/retain rule in the PII coverage manifest.
5. **Sign-up and sign-in are compliance features, not friction.** Email verification, throttling, the same answer whether or not an account exists ("if that address has an account, we've sent a link"), and an audit event for every attempt are WP-1.01 acceptance criteria and SOC 2 / DPDP controls. Don't remove them to make a demo smoother. Use the dev mailbox (Mailpit) instead.
6. **Nothing reaches the internet without the edition check.** Air-gapped installs must make no outbound calls, so outbound traffic goes through the egress port behind `@form/config`. Sending answers to any outside service is a disclosure: it needs declared purposes, the `data.route` permission and a `disclosures` row.
7. **Keep answers out of logs.** Log ids, not values. Who saw what goes in the audit log, not `console.log`.

## 6. The guards, and why they exist

Some tests and CI steps exist only to stop a whole class of bug. When one blocks you, the fix is almost always in your code, not in the guard. If you really think a guard is wrong, ask: changing a guard is a reviewed change on its own.

- **Purity and determinism tests** (`logic`, `validation`, `templates-core`, `i18n`). The server re-runs the same logic as the browser and rejects a submission when they disagree. `Date.now()`, `Math.random()`, locale-dependent APIs or DOM access in these packages make Node and the browsers disagree. Pass the clock and ids in (for example `meta.now`) instead.
- **Zod twins** (`packages/schema`). Every exported schema type has a strict zod twin, and the API parses untrusted input with it. A type without a twin is input nobody validates. When you add a field to a config type, add it to the twin and to `twins.test-d.ts`; `twins.coverage.test.ts` fails otherwise.
- **HTML-sink grep.** `innerHTML`, `dangerouslySetInnerHTML` and `execCommand` must not appear in `apps/` or `packages/`. Rich text is an AST rendered as React elements. To copy text, use `navigator.clipboard.writeText` with a visible fallback (select the text and ask the user to press Ctrl+C), not `document.execCommand('copy')`. Renaming things to get past the grep defeats the point.
- **i18n catalogue.** User-facing strings go through `defineMessages`. Run `pnpm i18n:extract` and commit the regenerated `packages/i18n/locales/en-IN/*.json` with your code; CI's `--check` fails on a stale catalogue.
- **Coverage floors.** `schema`, `registry`, `logic`, `validation`, `templates-core` and `templates` fail below 90% line coverage. New code there comes with tests.
- **Dependency rules** (`pnpm deps`). For example, `packages/schema` must not import React. Layers keep the shared packages usable on the server.

## 7. From a demo request to work

Demo feedback is valuable, and writing the asks down straight away is exactly the right first step. The next steps turn them into work that lasts:

1. **Find the row and the WP.** Look the ask up in [`01-feature-matrix.md`](docs/platform/01-feature-matrix.md) and the traceability table in [`04-delivery-plan.md`](docs/platform/04-delivery-plan.md) §8. The November 2026 asks are already mapped in §10.
2. **Read its Depends on and Acceptance.** If a dependency is not built yet (most server features need WP-1.12 submissions first), that comes first. A demo can still use a builder-only mock behind a flag, as long as it never touches the server or real data and never lands on `dev` as the real feature.
3. **No row?** Write a short proposed row and WP in the same style as the plan, and ask for sign-off before writing code. New scope needs a PM and tech-lead yes (risk R6).
4. **Build to the acceptance criteria.** Turn each acceptance line into a test. Reference the WP in your commits.
5. **Demo safely.** Demo from your machine or a staging environment with made-up data. A demo shortcut, such as publishing without signing in, is never merged as the feature.

## 8. When to ask for review

Ask before pushing when a change touches any of these:

- **Auth:** sessions, sign-up, sign-in, 2FA, password reset, invites
- **Access control:** roles, permissions, RLS policies, `withTenant`, any route with `auth: 'none'`
- **Money:** payments, billing, prices, GST
- **Migrations:** any new migration or table
- **Shared packages:** `schema`, `registry`, `logic`, `validation`, `db`, `config`, `i18n`, `renderer`. Everything else builds on them.
- **Data leaving the system:** webhooks, outside API calls, exports, email content
- **Compliance features:** consent, retention, DSR, audit

Asking for review is part of the job, not a sign that something is wrong. Senior engineers ask for it on exactly these areas too.

## 9. Checklist before each push

- [ ] Rebased on the latest `dev`
- [ ] `git status` shows only the files I meant to change; nothing generated
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm i18n:extract --check` and `pnpm build` pass (plus `pnpm test:int` for api, worker or db)
- [ ] Each commit message says why and names the WP
- [ ] Anything from section 8 has had a review
- [ ] After pushing: CI ran and is green
