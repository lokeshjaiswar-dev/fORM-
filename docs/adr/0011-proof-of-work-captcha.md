# ADR-0011: Proof-of-work captcha is the default in every edition

- **Status:** Accepted
- **Date:** 2026-10-19 (written up; the decision was taken in the v1.1 planning set, architecture §10)
- **Work package:** WP-1.13 (feature matrix rows SPM-01, SPM-02, FLD-29, CMP-11); provider gating in WP-0.15 and ADR-0002 §4

## Context

The first plan used hCaptcha by default. That sends respondent data to a foreign sub-processor on every form and makes third-party requests from respondent pages, against the privacy-by-default principle; air-gapped installs cannot reach any third-party captcha at all (C-M12). See [`docs/platform/03-architecture.md` §4.4](../platform/03-architecture.md).

## Decision

1. **Proof of work (ALTCHA-compatible, adaptive difficulty) is the default captcha provider in every edition** (`CAPTCHA_DEFAULT=proof_of_work`; a third-party value is rejected).
2. **It is the only provider when air-gapped** (`EGRESS_POLICY=none`).
3. hCaptcha, Turnstile and reCAPTCHA v3 are **per-form opt-ins**, allowed only when listed in `CAPTCHA_PROVIDERS` (default: all when egress is open, none otherwise), and must be declared in a purpose's `recipients` and on the sub-processor list.
4. Captcha modes are `off`, `always` and `on_suspicion` (spam score ≥ 0.5); captcha is one layer after rate limits, the render token and the honeypot.

## Consequences

- Respondent pages make no third-party requests by default; the CSP adds captcha origins only for forms that opt in.
- `capability:captcha_<provider>` is gated by the edition; `captcha_proof_of_work` always passes.
- Login throttling uses the same PoW challenge.

## Links

- Architecture §1.5 (`CAPTCHA_DEFAULT`, `CAPTCHA_PROVIDERS`, edition gating), §3.5, §4.4, §4.5, §6 (Captcha port)
- Delivery plan [WP-1.13](../platform/04-delivery-plan.md)
- Review log [C-M12](../platform/05-review-log.md)
- Related: [ADR-0002 §4](0002-phase0-batch2-decisions.md)
