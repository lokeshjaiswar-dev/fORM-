# ADR-0009: Chromium renders PDFs in an isolated image with no network

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10; delivery plan decision D7 is marked decided)
- **Work package:** WP-1.17 (feature matrix rows EXP-01, EXP-03); thumbnails for templates in the same image

## Context

Submissions, exports, email attachments, ending downloads and DSR exports need PDFs in Indian scripts. pdf-lib cannot shape Indic text (conjuncts, reordering), so a pdf-lib text path renders Devanagari and Tamil incorrectly (F-49). A headless browser renders correctly but is a large attack surface when it processes respondent content. See [`docs/platform/03-architecture.md` §5.2 and §7.1](../platform/03-architecture.md).

## Decision

1. **Chromium renders every PDF**: the renderer in print mode, then `page.pdf()`, with bundled Noto fonts and qpdf for passwords.
2. It runs in a **separate image, `fr-worker-pdf`** (`fr-server` plus Chromium, Noto fonts and qpdf), started as `server worker --queues=pdf.*,templates.thumbnail`.
3. **All network access is blocked** except local assets.
4. **No pdf-lib text path.**

## Consequences

- The main `fr-server` image carries no browser; only `worker-pdf` pods do, and they scale separately.
- WP-1.17's acceptance includes visual snapshots of Devanagari and Tamil.
- Custom PDF templates (P2) reuse the same renderer print mode.

## Links

- Architecture §1.1 (`apps/worker-pdf`), §5.2 (`pdf.render`), §7.1 (images)
- Delivery plan [WP-1.17](../platform/04-delivery-plan.md), decision D7 (§9)
- Review log [F-49](../platform/05-review-log.md)
- Related: [ADR-0019](0019-single-server-image.md)
