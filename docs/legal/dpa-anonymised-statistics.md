# DPA clause: anonymised cross-tenant statistics

**Version 2026-10-19 · draft for counsel review (BL-216) · for the SaaS Data Processing Agreement (WP-1.24)**

The platform counts how system templates and product features are used across customer organisations, for example to rank templates by popularity (TPL-11, templates spec §9). This clause lets it do so as the customer's Processor, and limits what may come out. On-prem deployments keep their counts local and send nothing anywhere; the clause does not apply to them.

## Clause

**X.1 Purpose.** The Processor may compute aggregate statistics from the metadata of the Customer's use of the Service (which system templates were previewed, used, published or updated, and how many forms and submissions are bound to them) for the sole purpose of operating and improving the Service, including showing template popularity to all customers.

**X.2 No Customer Personal Data.** Statistics are computed from usage events and counts only. They never include the contents of forms, submissions, uploaded files or messages, nor any identifier of a Data Principal who responded to a form.

**X.3 Threshold.** A statistic that combines data from more than one customer is disclosed outside the Processor, or shown to any customer, only when at least **five (5) distinct customer organisations** contributed to it. Statistics below that threshold are suppressed, not rounded or estimated.

**X.4 No re-identification.** Disclosed statistics do not identify the Customer, its users or any individual, and the Processor will not attempt to re-identify them or combine them with other data to do so.

**X.5 Separation.** Statistics are computed by a dedicated database role that can read only the usage and count sources and write only the aggregate tables, separate from the roles that serve the Customer's requests.

**X.6 Retention.** Raw usage events are kept for at most 400 days and then deleted; aggregates without Customer identifiers may be kept for the life of the Service.

**X.7 Termination.** When the Customer's organisation is deleted, its raw usage events are deleted with it. Aggregates already disclosed under X.3 are not recalled.

**X.8 The Processor's own users.** Usage events also describe the Customer's builder users, for whom the Processor is the Data Fiduciary of their account data; the platform privacy notice tells them about these statistics and the five-organisation threshold.

## How the product meets it

| Clause | Implementation |
|---|---|
| X.2 | `template_usages` holds event kinds, template and form ids and counts; no answers (templates spec §5, §9) |
| X.3 | Popularity and cross-tenant rollups hide any template used by fewer than 5 distinct orgs (WP-T1.7 acceptance: "popularity hides templates used by < 5 orgs") |
| X.5 | `fr_system_agg`: SELECT on rollup sources, INSERT on rollup tables, nothing else (architecture §2.2) |
| X.6 | `template_usages` 400-day TTL (templates spec §5) |
| X.7 | Org purge after the deletion cooling-off (CMP-17, `PII_COVERAGE.orgs`) |
| X.8 | Platform privacy notice, section "Why we use it" |

## Open points for counsel

- Whether X.1 fits within "processing on the Fiduciary's instructions" under DPDP s.8(2), or needs to be framed as an instruction the Customer gives by accepting the DPA.
- Whether five organisations is enough where an industry has few customers (a template used only by hospitals in one city); a per-category minimum may be needed.
