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
connect-src 'self' {PUBLIC_API_URL origin, if separate}; object-src 'none'; base-uri 'none'; form-action 'self';
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

## Development and preview

| Server | Policy | Reports |
|---|---|---|
| `pnpm dev` (Vite dev server) | Production policy plus `'unsafe-inline'` for scripts and styles: React Refresh is an inline script and Vite serves CSS as `<style>` elements. Trusted Types is sent as `Content-Security-Policy-Report-Only`, so the Vite error overlay still works and violations still show | `/__csp-report` on the dev server |
| `vite preview` (and `pnpm e2e`) | The production policy, unchanged | `/__csp-report` on the preview server |

Both Vite servers name only `report-uri`. With `report-to` present, Chromium uses the Reporting API alone, which sends reports in the background with no deadline; in headless Chromium none arrived within 70 seconds. `report-uri` arrives at once, so the e2e suite can assert it. The collector (`security/vite.ts`) keeps the last 500 reports: `GET /__csp-report` lists them, `DELETE` clears them.

Both proxy `/v1` to `pnpm dev:api` (`http://127.0.0.1:8080`, or `FR_DEV_API_URL`) unless `VITE_API_URL` names a separate API origin.

## What keeps the build clean

The e2e fixture (`apps/builder/e2e/test.ts`) listens for `securitypolicyviolation` on every page and fails any test that raises one. `e2e/csp.spec.ts` checks the headers, provokes one violation of each kind (an HTML sink, an injected `<style>`, a foreign `fetch` and image) and finds each in the reports, and checks that a framed builder is refused. Three dependencies needed changes to run under this policy:

| Dependency | Problem | Fix |
|---|---|---|
| zod 4 | Its JIT compiles parsers with `new Function`, and the probe for that is already a violation | `src/csp.ts` sets `z.config({ jitless: true })` before any other module loads |
| Tiptap | Injects its base styles as a `<style>` element through `innerHTML` | Editors run with `injectCSS: false`; the rules are in `src/index.css` |
| sonner | Injects its stylesheet as a `<style>` element when it loads | The production build drops that call (`noInjectedStyles` in `security/vite.ts`, which fails the build if the call changes shape); `main.tsx` imports `sonner/dist/styles.css` |

A new dependency that injects styles or evaluates strings fails the e2e suite. Fix it the same way. Do not loosen the policy.
