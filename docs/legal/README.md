# Legal texts

Drafts of the texts the platform needs as a Data Fiduciary for its own users and as a Data Processor for its customers (CMP-21, architecture §8 #4 and #24). **None of them is final until counsel signs them off** (BL-216); until then they are engineering drafts that state what the product actually does, so counsel can check the wording against the behaviour.

| Text | Who it binds | Where the product implements it |
|---|---|---|
| [Platform privacy notice](platform-privacy-notice.md) | The platform (or the on-prem operator) towards builder users | `GET /v1/privacy/notice`, sign-up, the account's Privacy page; `user_notice_acks` |
| [DPA clause: anonymised cross-tenant statistics](dpa-anonymised-statistics.md) | The platform towards customer orgs (SaaS DPA) | Template popularity and usage rollups (WP-T1.7, `fr_system_agg`), at least 5 distinct orgs |
| [Support-access DPA for on-prem bundles](support-access-dpa.md) | The vendor towards an on-prem customer who sends a support bundle | `form-admin support-bundle` (WP-1.24, WP-1.27); break-glass for SaaS is architecture §8 #4 |
| [Builder-user requests: operator procedure](builder-user-requests.md) | The operator's privacy contact | `user_grievances`, the account export and deletion |

The customer-facing DPA itself, the sub-processor list and the RoPA export are WP-1.24; the clause and the support-access text here are written to drop into it.

Each text names the version it describes. A change in product behaviour that one of them describes changes the text in the same pull request; the privacy notice also has a test (`apps/api/src/modules/account/notice.test.ts`) that fails when its code and its page disagree.
