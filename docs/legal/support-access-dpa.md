# Support-access terms for on-prem support bundles

**Version 2026-10-19 · draft for counsel review (BL-216) · annex to the on-prem licence and support agreement**

On-prem, the customer runs the platform and is the Data Fiduciary for everything in it, including its own builder users' accounts. The vendor has no access to the deployment. When the customer asks for help, its operator may run `form-admin support-bundle` and send the vendor the resulting archive (architecture §7, "On-prem"). These terms cover what the vendor may do with that archive. Nothing phones home: a bundle leaves the deployment only when the customer sends it.

## Terms

**S.1 Roles.** For the contents of a support bundle the Customer is the Data Fiduciary and the Vendor is its Data Processor. The Vendor processes a bundle only to diagnose and fix the problem the Customer reported (the "Ticket").

**S.2 What a bundle contains.** A bundle holds the deployment's configuration with every secret removed, service versions, health and migration status, and logs of the period the Customer chooses. It is built to exclude form contents, submissions, uploaded files, message bodies, passwords, keys and tokens. Logs carry request ids, keyed hashes of IP addresses and the user ids of builder users, never respondents' answers.

**S.3 Customer review.** The Customer can inspect the archive before sending it and may remove anything from it. The Vendor will not ask for database dumps, backups or exports of submissions; if a problem cannot be diagnosed without personal data, the Vendor will say what it needs and why, and the Customer decides.

**S.4 Personal data that slips through.** If the Vendor finds personal data in a bundle that S.2 says should not be there, it stops processing that part, tells the Customer within 72 hours, deletes the affected files, and treats the gap in redaction as a defect to fix.

**S.5 Access.** Only the Vendor's support engineers working on the Ticket may open a bundle. Bundles are stored encrypted, in India unless the Customer agrees otherwise in writing, and never in a ticketing or chat tool that is not on the Vendor's sub-processor list.

**S.6 Retention.** The Vendor deletes a bundle within 30 days after the Ticket is closed, or sooner on the Customer's request, and confirms the deletion when asked.

**S.7 No other use.** The Vendor does not use bundles to train models, build statistics, or for any purpose other than the Ticket, and does not disclose them to anyone except the sub-processors named for support.

**S.8 Breach.** A personal data breach involving a bundle is notified to the Customer under the breach terms of the main agreement (a preliminary notice within 24 hours of becoming aware, updates every 24 hours; decision D15).

**S.9 Remote sessions.** Screen-sharing or remote sessions the Customer grants are run and recorded on the Customer's side, end with the session, and give the Vendor no standing access.

## How the product meets it

| Term | Implementation |
|---|---|
| S.2 | `form-admin support-bundle` collects redacted logs and config (WP-1.24, packaged with WP-1.27); the services' logger already redacts secrets and scrubs request URLs (`@form/observability`), and audit records carry keyed IP hashes only |
| S.3 | The bundle is a plain archive the operator writes to disk; it is never uploaded by the tool |
| S.5, S.6 | Vendor-side support process (WP-1.24 access reviews and the sub-processor list) |
| S.8 | Breach runbook and Processor-to-Fiduciary notices (WP-1.24) |

## Open points for counsel

- Whether S.4's 72 hours should match the 24-hour preliminary breach notice instead, when the data that slipped through is sensitive.
- Whether builder-user ids in logs need a mention in the customer's own notice to its builder users (they are the customer's users on-prem).
