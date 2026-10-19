# ADR-0020: Rich text is a constrained AST, never HTML

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; decided by the schema v2 design and delivered in WP-0.08)
- **Work package:** WP-0.08 (feature matrix rows FND-08, BLD-03, PROP-01 label; bugs S1–S4)

## Context

The v1 builder stored labels, descriptions and paragraphs as raw HTML written through `contentEditable` and `execCommand`, rendered it through `innerHTML`, and so allowed stored XSS (S1–S4: `RichText.tsx`, `FormPreview.tsx`). Rich text appears everywhere a form says something: labels, descriptions, paragraphs, endings, status screens, consent notices, emails and PDFs. It also has to carry answer piping (PRE-02) and template variables. See [`docs/platform/02-form-schema-v2.md` §2](../platform/02-form-schema-v2.md) (invariants I5 and I6, section "§2 RICH TEXT") and the feature matrix row FND-08.

## Decision

1. **No HTML anywhere (I5).** Rich text is stored as a TipTap/ProseMirror-compatible JSON subset: `RichDoc` (multi-block: paragraphs, headings, lists, blockquotes, horizontal rules, images) and `InlineDoc` (exactly one paragraph: labels, sub-headings, titles). Marks are bold, italic, underline, strike, code, link, `textColor` and `highlight`; colours are a theme token (preferred), a hex value or a brand reference. Inline atoms are text, hard breaks, `pipe` (answer piping) and `var` (template variables).
2. **Links and media are allowlisted (I6).** A link holds a `SafeHref` (http(s), `mailto:` or `tel:` only); `rel="noopener noreferrer nofollow"` and `target` are added by the renderer, never stored. Images are `AssetRef`s or brand references, never external URLs.
3. **Limits are part of the type:** at most 20k nodes, depth ≤ 8, lists ≤ 3 deep, checked by the zod twins before recursion. Rich text outside the allowed AST is the PublishIssue `invalid_rich_text` (ADR-0002 §1).
4. **HTML is only ever parsed in `@form/schema`**: `fromHtml` / `fromHtmlInline` turn v1 label HTML and clipboard HTML into the AST through an htmlparser2 allowlist, never a DOM, and never execute anything. `normalizeRichDoc` / `normalizeInlineDoc` turn editor JSON into the canonical AST with `RICH_TEXT_PROFILE` or the stricter `PASTE_PROFILE`.
5. **Rendering maps nodes to React elements** (`@form/renderer` `RichTextView`); `pipe` and `var` resolve through a resolver prop.
6. **Editing uses TipTap 3** (`InlineEditor`, `RichEditor`) with Link (`isAllowedUri`), colour and highlight limited to tokens and the palette, and reserved `pipe` and `var` extensions. Paste from outside keeps only bold, italic, underline, links and lists; copy and paste between builder editors keeps the full AST through the builder's own clipboard payload, normalized and limit-checked again on paste (ADR-0002 §7).
7. **Nothing reads or writes `innerHTML`.** A CI grep for `innerHTML|dangerouslySetInnerHTML|execCommand` over `apps` and `packages` must find 0 matches.

## Consequences

- The DOMPurify shim and `RichText.tsx` are gone; there is no sanitiser to keep up to date, because there is no HTML to sanitise.
- Email bodies (`EmailDoc`: rich text plus email-only nodes) and PDF headers and footers reuse the same AST; `@form/email` (P1) turns `EmailDoc` into table-based HTML and text.
- Plain-text contexts (keys, names, subjects) use `toPlain`; single-line templates use `PlainTemplate`, not rich text.
- A ≥ 150-payload XSS corpus (`packages/schema/test/fixtures/xss.ts`) is shared by the schema, the renderer and the builder's unit and e2e tests.
- The API checks rich text again at save and at publish (feature matrix FND-08), with the same twins.

## Links

- Schema spec §1 (rich text taken from design D2), §2 (I5, I6, the rich text section, `invalid_rich_text`), §4.2 (raw HTML labels in migration)
- Delivery plan [WP-0.08](../platform/04-delivery-plan.md)
- Feature matrix [FND-08, BLD-03, FLD-45, PROP-01](../platform/01-feature-matrix.md)
- [`packages/schema/README.md`](../../packages/schema/README.md) (`src/richtext`, "HTML is only ever parsed here")
- Related: [ADR-0002 §1 and §7](0002-phase0-batch2-decisions.md)
