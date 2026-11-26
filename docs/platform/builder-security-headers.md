# Builder security headers (FND-20, WP-1.05)

The builder (`apps/builder`) is a static single-page app. Every response that serves it (`index.html`, the SPA fallback and the hashed assets) carries the headers below. Architecture §4.5 sets the policy; this page says how to serve it.

One module defines them: `apps/builder/security/headers.ts`. The Vite dev server, `vite preview` and the production configuration all come from it, so they cannot drift. A unit test (`security/headers.test.ts`) checks that the nginx blocks on this page are exactly what the module generates.

## The headers

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see below | Scripts and styles only from the builder's own origin, no framing, Trusted Types enforced |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Builder URLs (form ids) never leave the site in full (architecture §4.5) |
| `X-Content-Type-Options` | `nosniff` | No MIME sniffing of assets |
| `X-Frame-Options` | `DENY` | `frame-ancestors 'none'` for browsers that predate it |
| `Cross-Origin-Opener-Policy` | `same-origin` | A page the builder opens cannot reach back into it |
| `Reporting-Endpoints` | `csp="<report URL>"` | The Reporting API endpoint that `report-to csp` names |

`Strict-Transport-Security` is set by the TLS terminator (ingress or CDN) for every host, not by this module.

The production `Content-Security-Policy`:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self';
connect-src 'self' {PUBLIC_API_URL origin, if separate} {FP_DMS_API_ORIGINS, if set}; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none';
report-uri {report URL}; report-to csp
```

- **No inline code at all.** No `'unsafe-inline'`, no `'unsafe-eval'`, no nonces or hashes: the Vite build emits only external scripts and stylesheets.
- **Trusted Types, no policies.** `require-trusted-types-for 'script'` makes every DOM HTML and script sink (`innerHTML`, `DOMParser.parseFromString`, `script.src`, `eval`, …) throw. `trusted-types 'none'` forbids creating a policy, so no library can open one. Rich text is an AST rendered as React elements (FND-08), so the builder needs no sink.
- **Reports** go to `POST /v1/csp-reports` on the API. It accepts both formats (`application/csp-report` from `report-uri`, `application/reports+json` from the Reporting API) and logs one scrubbed `warn` line per violation. The line keeps the directive, the disposition, the blocked origin or keyword, and the document and source URLs without query values. It never keeps the script sample. A process logs at most 600 violations a minute and counts the rest.

## Production serving

Print the headers for a deployment from its `PUBLIC_API_URL` (architecture §1.5):

```bash
PUBLIC_API_URL=https://api.form.example pnpm --filter @form/builder headers:nginx
```

**SaaS** (the API on its own origin, `api.<domain>`):

```nginx
location / {
  root /usr/share/form/builder;
  try_files $uri /index.html;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://api.form.example; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; report-uri https://api.form.example/v1/csp-reports; report-to csp" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Reporting-Endpoints "csp=\"https://api.form.example/v1/csp-reports\"" always;
}
```

**On-prem, one host** (the ingress routes `/v1/*` to the API, so the builder calls it on its own origin; `PUBLIC_API_URL` unset):

```nginx
location / {
  root /usr/share/form/builder;
  try_files $uri /index.html;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; report-uri /v1/csp-reports; report-to csp" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Reporting-Endpoints "csp=\"/v1/csp-reports\"" always;
}
```

Rules for whoever serves the build:

- Use `always`, so error pages carry the headers too.
- nginx does not inherit `add_header` into a block that sets its own. A `location` for `/assets/` that adds `Cache-Control` must repeat the lines above.
- Do not add an inline script (analytics, a config blob) to `index.html`. The policy refuses it, and the builder reads its runtime settings from the API (`GET /v1/meta/edition`).
- The API's CORS origin (`PUBLIC_BUILDER_URL`) must be the builder's origin: the Reporting API sends its batches with a CORS preflight.

## Embedded pages (`/embed/*`, DMS+)

`/embed/*` is fORM- hosted inside another product: `/embed/dms-master` (the master builder, a top-level page: DMS navigates to it, it is never framed), `/embed/dms-record` (the record form, also a top-level page, never framed) and `/embed/dms-upload` (the field form of the DMS upload step, in an iframe on the classic frontend). Only `/embed/dms-upload` may be framed, and only by the origins in `VITE_FP_EMBED_PARENTS` (build time, comma separated; unset means the page's own origin). Every other route, `/embed/dms-master` and `/embed/dms-record` included, keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

Both embed pages call the DMS API, which usually has its own origin. List those origins in `connect-src`: `VITE_FP_DMS_API_ORIGINS` at build time for the Vite servers, `FP_DMS_API_ORIGINS` (comma separated origins, the same list) when you print the headers. Without it a static build blocks every DMS call from the browser. The launch allowlist is a separate, exact list: `VITE_FP_DMS_API_BASE` (origin and path, comma separated; `/api` resolves against the page origin). The descriptor's `apiBase` must equal one entry, path included, or the launch is refused (the DMS token goes to those bases only; fetch does not follow redirects). Set it on the plain `location /` block too: `/embed/dms-master` is served by it.

The `/embed/dms-upload` response carries the same headers with two differences: `frame-ancestors 'self' <origins>`, and no `X-Frame-Options` (it cannot name an origin list). It checks the same list in the browser: it reads `?fp_parent=<origin>` only when that origin is listed, and then reads only messages whose `event.source` is the framing window and whose `event.origin` is that origin (`src/embed/bridge/`). Set `FP_EMBED_PARENTS` when you print the headers to get the lines for the extra location (here for an on-prem host with the DMS+ origin `https://dms.example`):

```nginx
location = /embed/dms-upload {
  root /usr/share/form/builder;
  try_files /index.html =404;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://dms.example; require-trusted-types-for 'script'; trusted-types 'none'; report-uri /v1/csp-reports; report-to csp" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Reporting-Endpoints "csp=\"/v1/csp-reports\"" always;
}
```

The Vite dev and preview servers do the same from `VITE_FP_EMBED_PARENTS` for `/embed/dms-upload` only (`security/vite.ts`, `embedFraming`).

## The container image (`apps/builder/Dockerfile`, v2)

The image builds `@form/builder` with pnpm and serves it from `nginxinc/nginx-unprivileged` on port 8080, under `/formplus/` (`VITE_BASE=/formplus/`). Build from the repository root:

```bash
docker build -f apps/builder/Dockerfile \
  --build-arg VITE_FP_DMS_API_BASE=https://dms.example/api \
  --build-arg VITE_FP_DMS_API_ORIGINS=https://dms.example \
  --build-arg VITE_FP_EMBED_PARENTS=https://dms.example \
  -t form-builder .
```

The build args are the same `VITE_*` names the Vite servers read (`VITE_API_URL`, `VITE_FP_DMS_API_BASE`, `VITE_FP_DMS_API_ORIGINS`, `VITE_FP_EMBED_PARENTS`, `VITE_WEBHOOK_DOCS_URL`, plus `FP_PUBLIC_ORIGINS` and `VITE_FP_LEGACY_DESCRIPTOR`). They are baked into the bundle and into three header files, which `security/render-nginx.ts` writes at build time from `security/headers.ts` (so the image, `headers:nginx` and the Vite servers cannot drift): `plain.conf` (the SPA), `embed-page.conf` (`/embed/dms-master` and `/embed/dms-record`, the plain set without `report-uri`) and `upload.conf` (`/embed/dms-upload`: the sandboxed set `sandboxedEmbed` in the default build, today's framable set without `report-uri` in the `VITE_FP_LEGACY_DESCRIPTOR=1` build used for the M2 upload-v2 bridge). Nothing secret is a build arg.

`apps/builder/deploy/nginx.conf.template` is rendered by the image entrypoint (only `FP_WEB_ROOT` and `FP_HEADERS_DIR` are substituted):

| Path | Answer |
|---|---|
| `/formplus/healthz` | `200 ok`, no headers, not logged (probe) |
| `/formplus` | `301 /formplus/` |
| `/formplus/embed/dms-upload` | the SPA with `upload.conf`: default build, the sandboxed set (CSP `sandbox`, `connect-src 'none'`, `Cache-Control: no-store`, no `report-uri`); `VITE_FP_LEGACY_DESCRIPTOR=1` build, `frame-ancestors 'self' <VITE_FP_EMBED_PARENTS>` and no `X-Frame-Options` |
| `/formplus/assets/*` | hashed build output with `plain.conf`, `Cache-Control: public, max-age=31536000, immutable` |
| `/formplus/embed/*` (`dms-master` and `dms-record`) | `index.html` with `embed-page.conf`: `frame-ancestors 'none'`, `X-Frame-Options: DENY`, no `report-uri` (full-page launches) |
| `/formplus/*` (SPA fallback) | `index.html` with `plain.conf`: `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| `/formbuilder/sharemaster` | `301 /sharemaster`, query string kept (the share token rides in it) |
| any other `/formbuilder/*` | `410 Gone` with the static page `deploy/moved.html` (OpenForm is retired, decisions.md item 6) |
| anything else | `404` |

The ingress sends `/formplus/` and `/formbuilder/` to this container; `/sharemaster` stays with DMS. `connect-src` of the plain and embed-page header files lists every DMS API origin (`VITE_FP_DMS_API_ORIGINS` plus the origin of each absolute `VITE_FP_DMS_API_BASE` entry), so the browser may call DMS; without them every DMS call is blocked. `security/deploy.test.ts` checks the template and the generated files; the template was also run through `nginx -t` and exercised with curl in a throwaway nginx container.

## Development and preview

| Server | Policy | Reports |
|---|---|---|
| `pnpm dev` (Vite dev server) | Production policy plus `'unsafe-inline'` for scripts and styles: React Refresh is an inline script and Vite serves CSS as `<style>` elements. Trusted Types is sent as `Content-Security-Policy-Report-Only`, so the Vite error overlay still works and violations still show | `/__csp-report` on the dev server |
| `vite preview` (and `pnpm e2e`) | The production policy, unchanged | `/__csp-report` on the preview server |

Both Vite servers name only `report-uri`. With `report-to` present, Chromium uses the Reporting API alone, which sends reports in the background with no deadline; in headless Chromium none arrived within 70 seconds. `report-uri` arrives at once, so the e2e suite can assert it. The collector (`security/vite.ts`) keeps the last 500 reports: `GET /__csp-report` lists them, `DELETE` clears them.

Both proxy `/v1` to `pnpm dev:api` (`http://127.0.0.1:8080`, or `FR_DEV_API_URL`) unless `VITE_API_URL` names a separate API origin.

## What keeps the build clean

The e2e fixture (`apps/builder/e2e/test.ts`) listens for `securitypolicyviolation` on every page and fails any test that raises one. `e2e/csp.spec.ts` checks the headers, provokes one violation of each kind (an HTML sink, an injected `<style>`, a foreign `fetch` and image) and finds each in the reports, and checks that a framed builder is refused. Five dependencies, and one build default, needed changes to run under this policy:

| Dependency | Problem | Fix |
|---|---|---|
| zod 4 | Its JIT compiles parsers with `new Function`, and the probe for that is already a violation | `src/csp.ts` sets `z.config({ jitless: true })` before any other module loads |
| Tiptap | Injects its base styles as a `<style>` element through `innerHTML` | Editors run with `injectCSS: false`; the rules are in `src/index.css` |
| sonner | Injects its stylesheet as a `<style>` element when it loads | The production build drops that call (`noInjectedStyles` in `security/vite.ts`, which fails the build if the call changes shape); `main.tsx` imports `sonner/dist/styles.css` |
| Radix Select and ScrollArea | Write a viewport `<style>` through `innerHTML` when they mount, which throws under Trusted Types and `style-src`, so the whole React tree stops rendering | The build takes the element out and bundles the same rules into the stylesheet (`radixViewportStyles` in `vite.config.ts`, which fails the build if the element changes shape) |
| react-remove-scroll (Radix Dialog, Select, DropdownMenu) | Appends a `<style>` for the scroll lock, whose rules depend on the scrollbar width | The build replaces react-style-singleton's stylesheet with a constructable one in `document.adoptedStyleSheets` (`adoptedScrollLockStyles` in `vite.config.ts`, which fails the build if the module changes shape) |
| Vite (fonts) | Inlines assets under 4 kB, so a small font subset became a `data:` URL that `font-src 'self'` refuses | `build.assetsInlineLimit` never inlines a font file |

A new dependency that injects styles or evaluates strings fails the e2e suite. Fix it the same way. Do not loosen the policy.
