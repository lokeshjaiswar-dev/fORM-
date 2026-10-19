# @form/renderer

The respondent UI (FND-04, BLD-11, DSN-11, FLD-10; WP-0.10): `FormRenderer` shows one `RuntimeFormVersion` and depends on no store. The runtime (WP-1.x) and the builder preview give it the version, a status, an uploader and callbacks; everything it does to the outside world goes through those props.

```tsx
import { FormRenderer } from '@form/renderer';
import '@form/renderer/styles.css';

<FormRenderer
  version={runtimeVersion}          // projectForRuntime() output (GET /f/:slug)
  mode="live"                       // or 'preview': meta.isPreview; the redirect URL is built locally
  status={runtimeVersion.status}    // closed, password, … screens; the host swaps it after /session or an unlock
  locale="en-IN"
  messages={catalogues}             // optional; the en-IN source catalogues are the fallback
  uploader={upload}                 // (UploadRequest) => Promise<FileRef>: files and signature PNGs (S10)
  onSubmit={submit}                 // (SubmitPayload) => SubmitResult | void
  onPartialSave={saveDraft}         // optional, after each page
  onEvent={track}                   // page, invalid, submitted, submit_failed, redirect, unlock, start, restart
  onUnlock={checkPassword}          // optional: the password typed on a password screen (never in an event)
  session={{ startedAt, urlParams }} // meta.now and the URL parameters, fixed for the session
  theme={designPanelTheme}          // optional override of version.definition.theme
/>
```

| Path | What it holds |
|---|---|
| `src/FormRenderer.tsx` | The root: theme variables on `.fr-root`, status screens, the session (react-hook-form, paging, submit, ending) |
| `src/eval/` | `EvalSession` over `createEvaluator` (`meta.now` frozen at session start; `update()` re-runs only the steps whose `reads` changed), `EvalProvider` driven by `useWatch` |
| `src/rhfResolver.ts` | The react-hook-form resolver: evaluate, then `validateAnswers` in the page scope (Next) or the submit scope |
| `src/controls/<type>.tsx` | One control per available type; `controls/index.ts` is the `Record<AvailableType, Control>` with how each is labelled |
| `src/fields/Field.tsx` | Label (`htmlFor`), `fieldset`/`legend` or `role="radiogroup"`, description and error ids for `aria-describedby`, the required marker, block styles |
| `src/layout/rows.ts` | Rows packed from `layout.width` and `startNewRow`; one column below 640px |
| `src/screens/` | `Status` (closed, not open, limit reached, password, already submitted) and `Ending` (message, redirect, fill again) |
| `src/theme/cssVars.ts` | Theme tokens → `--fr-*` custom properties; `accentText` defaults to black or white, whichever reads better on the accent |
| `src/signature/SignaturePad.tsx` | Drawing surface scaled by `devicePixelRatio`, Clear, a PNG `Blob` per stroke |
| `src/answers.ts`, `src/text.ts` | Starting answers (host answers over field defaults), pipes and plain templates |
| `src/styles.css` | Every rule scoped under `.fr-root` (as `:where(.fr-root) …`, which adds no specificity), reading only the theme variables. The renderer's rules never reach the host page; host rules that match inside `.fr-root` still apply |

## Rules

- **Answers.** Controls hold tagged answers (`{ type, value }`) in react-hook-form; blank values are dropped before evaluation and validation (I9). The submit payload's `answers` is `EvalState.values`: hidden, disabled and off-path answers are never sent.
- **Validation.** Next validates the current page, Submit the whole path (B1, B2), with the same `@form/validation` the API runs (through `@form/validation/lazy`: re2js loads only for a form with a short-text preset, pattern or mask). Errors are shown under each field, the count is announced in the `aria-live` region, and the first invalid field takes focus. An error on an earlier page (a server `invalid` result, or Submit) takes the respondent back to that page; an error on no page of the path is shown with the form-level errors. A field that showed an error is validated again on every change.
- **Uploads.** Files go to `uploader` when picked, signatures after each stroke or when the typed name is committed (on blur or Enter); Next and Submit wait for the PNG encoding and every upload in flight. The answer holds only `FileRef`s.
- **Session.** `meta.now` is read once per session, at mount (or from `session.startedAt`), and does not move when time passes or the session props change. "Submit another response" starts a new session with a new clock unless the host passed `startedAt`. Shuffled options are seeded per session (`session.shuffleSeed`, by default the version id and the session start), so Back keeps the order and respondents see different orders (PROP-11).
- **Next and Submit.** One at a time: while uploads, the regex engine or the submission are pending the button is `aria-busy` and `aria-disabled`, and further clicks are ignored, so a response is sent once.
- **Redirects.** The renderer never navigates: it reports `{ type: 'redirect', url, delayMs }` and the host goes there (the top window from an embed). In `live` mode the URL is the `redirectUrl` the server returned (the server interpolates it); in `preview` the renderer builds it, percent-encoding every piped value whatever the pipe's `encode`, as it does for `visit_url` actions. Either way only an `https:` URL that passes `isSafeUrl` is reported.
- **Accessibility.** Every control is labelled (`label htmlFor`, `fieldset`/`legend`, or `role="radiogroup"` with `aria-checked` points for rating, scale and NPS, moved with the arrow keys), invalid controls carry `aria-invalid` and point at their error, required fields have a marker in the theme colour and screen-reader text, the ending takes focus, and confetti respects `prefers-reduced-motion`. Single-choice dropdowns are native `<select>`s; multi-select dropdowns open a group of checkboxes.
- **SSR.** No `window` or `document` at module scope or during render; ids come from `useId`; pass `session.startedAt` so the server and the browser agree on `meta.now` (a date default of today).
- **Text.** Everything the renderer writes itself comes from the `renderer` and `system` catalogues; under `en-XA` no renderer text is left outside ⟦ ⟧ (BL-010).
- **Not yet.** Cards layout (DSN-05), image choices, logo and cover images (they need the asset store), calendar and select date pickers, email confirmation and the remaining types (registry stubs) arrive with their work packages; a version that uses them does not compile.

## Budget

`test/bundle.test.ts` builds the renderer with Vite, React and the catalogues excluded, and measures what the WP-0.10 acceptance names: everything the entry loads up front, shared engines included. **The 90 KB criterion is not met, and no renderer change can meet it:** the initial load is about 131 KB gzipped, and the shared engines the renderer has to run load about 96 KB on their own (zod twins about 29 KB, which logic evaluation checks answers with; decimal.js full build about 14 KB; the ICU parser about 11 KB; the engines' own code about 42 KB). The spec owner decides (BL-129). re2js is a separate chunk of about 46 KB that only forms with a preset, pattern or mask load (BL-099). The test holds the initial load to a 132 KB ratchet, the engines alone to 97 KB, the re2js chunk to 50 KB, and the renderer's own code with react-hook-form (about 35 KB) to 90 KB.

```sh
pnpm --filter @form/renderer typecheck
pnpm --filter @form/renderer test   # contracts per type, flows, SSR + hydration on every fixture, axe, en-XA, bundle budget
```
