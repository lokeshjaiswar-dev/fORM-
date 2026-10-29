# Privacy notice for fORM- accounts

**Version 2026-10-19 · en-IN · draft for counsel review (BL-216)**

This is the notice the builder shows at sign-up and on the account's Privacy page (CMP-21, DPDP Act s.5, Rules r.3). The API serves it from `apps/api/src/modules/account/notice.ts` at `GET /v1/privacy/notice`, with the operator's details filled in; `notice.test.ts` checks that every sentence below matches the code word for word. The placeholders are filled from the API configuration:

| Placeholder | Setting | Example |
|---|---|---|
| `{fiduciary}` | `PRIVACY_FIDUCIARY_NAME` (default `fORM-`) | the SaaS operator, or the customer running the service on-prem |
| `{contact}` | `PRIVACY_CONTACT_NAME` (default "our privacy contact") | "the Grievance Officer, Asha Rao" |
| `{email}` | `PRIVACY_CONTACT_EMAIL` (required in production) | `privacy@form.example` |
| `{version}` | the notice version | `2026-10-19` |

**Changing the notice.** Any change to the wording, however small, needs a new version (`NOTICE_VERSION`, `YYYY-MM-DD` with an optional `.n`) and this page updated in the same change. Each user acknowledges a text by its SHA-256 (the hash covers the filled-in contact details too), so changing a placeholder setting also asks every user to read the notice again. Sign-ups that carry an older version are refused with `NOTICE_OUTDATED`, and existing users see the new text on their Privacy page until they acknowledge it. Acknowledgements live in `user_notice_acks`, one row per user and text, and stay after an account is deleted.

---

## Who is responsible

{fiduciary} runs this service and is the Data Fiduciary for the personal data of your account under the Digital Personal Data Protection Act, 2023.

Forms and the responses they collect belong to the organisations that publish them. Each organisation is the Data Fiduciary for its forms and responses, and we process them only on its instructions. This notice is about your account, not about those responses.

## What we collect

We collect only what your account needs:

- Your name and email address, which you give us when you sign up, or which Google or Microsoft share with us when you sign in with them.
- Your password, kept only as a one-way hash, and, if you turn on two-factor sign-in, your authenticator key (encrypted) and your recovery codes (hashed).
- Sign-in and security records: your sessions, a short description of the browser you used, a keyed hash of your IP address that changes every day (never the address itself), and a log of sign-ins and account changes.
- The organisations you belong to and your role in each.
- The privacy requests and complaints you send us, and which version of this notice you were shown.

## Why we use it

- To create and run your account, sign you in and let you work in your organisations.
- To keep your account and the service secure: limiting sign-in attempts, detecting abuse, investigating incidents, and keeping the security logs Indian law requires.
- To send you messages about your account: sign-in links, confirmations and security alerts. We do not send marketing from these records.
- To count how the service is used. Counts that combine several organisations are shown only when at least five different organisations contributed, and never name you or your organisation.

## Who sees it

- The organisations you belong to see your name, email address and role.
- Providers that host and run this service for us, such as hosting and email delivery, process it only on our instructions.
- We do not sell your data, and we disclose it to authorities only when the law requires us to.

## How long we keep it

- Your account data stays until you delete your account.
- Sessions end after 14 days at most, and emailed links expire within a day.
- Security and audit records are kept for 13 months online, then archived for up to 7 years in a log that cannot be edited. Once your account is deleted, they refer only to an identifier that no longer names you.
- Deleted data leaves our backups as they expire, within 35 days.

## Your choices and rights

- See and download what we hold about you, at any time, from the Privacy page of your account.
- Correct your name, or ask us to correct anything else.
- Delete your account. This also withdraws your consent; it does not undo what was done before. If you are the last owner of an organisation, first make someone else an owner, or delete the organisation.
- Nominate someone to exercise these rights for you if you die or can no longer do so yourself.
- Forms and responses belong to your organisations: an owner or admin of the organisation manages them.

## Questions and complaints

Write to {contact} at {email}, or send a request from the Privacy page of your account. We answer within 90 days, and sooner when we can.

If you are not satisfied with our answer, you can complain to the Data Protection Board of India.

## Changes to this notice

When we change this notice, the builder shows you the new version and records that you saw it. This is version {version}.

---

## Version history

| Version | Change |
|---|---|
| 2026-10-19 | First version (WP-1.31). |

## Notes for reviewers

- **What it covers.** `users`, `user_identities`, `sessions`, `auth_tokens`, `memberships`, `user_notice_acks`, `user_grievances` and the user's own events on the platform audit chain. Billing contacts (WP-1.26) and template usage events (WP-T1.7) join the notice, the export and the deletion when those tables land (BL-214, BL-215).
- **Consent and withdrawal.** The account is processed on the consent given at sign-up; deleting the account is the withdrawal, as easy as signing up. Security logging after deletion rests on the legal duties the notice names (CERT-In Directions 2022), against a pseudonymous id.
- **Cross-tenant statistics.** The "at least five organisations" rule is the clause in [the DPA](dpa-anonymised-statistics.md); template popularity enforces it (WP-T1.7).
- **Languages.** English (India) only for now; a Hindi translation, and the 22 languages of the Eighth Schedule on request, are BL-217.
