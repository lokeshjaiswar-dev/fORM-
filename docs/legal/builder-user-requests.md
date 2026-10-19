# Builder-user requests: operator procedure

**Version 2026-10-19 · for the privacy contact named in `PRIVACY_CONTACT_EMAIL`**

How the operator (the SaaS platform, or the customer that runs fORM- on-prem) answers its own builder users' privacy requests and grievances (CMP-21, DPDP s.11 to s.14). Requests from the people who *answered* a form go to the org that owns the form, not here (DSR intake, WP-1.23).

## What users can do themselves

| Right | Self-service | API |
|---|---|---|
| Notice | Read it at sign-up, at `/privacy` and on the account's Privacy page; acknowledge a new version there | `GET /v1/privacy/notice`, `POST /v1/me/notice` |
| Access | Privacy page → *Download my data* (JSON: profile, linked accounts, sessions, memberships, notices acknowledged, requests, their own security events of the last 13 months) | `POST /v1/me/export` |
| Correction | Privacy page → *Your name*; other corrections by request | `PATCH /v1/me` (name) |
| Erasure and withdrawal of consent | Privacy page → *Delete my account* | `GET /v1/me/deletion`, `POST /v1/me/delete` |
| Grievance, nomination, anything else | Privacy page → *Send request*, or email the privacy contact | `POST /v1/me/grievances` |

Point users to the self-service first; it is immediate and audited.

## Answering a request

Every request gets a reference (`GRV-XXXXXXXX`), a due date 90 days out, a receipt to the user, and a copy to the privacy contact with the user's address and message. Until the operator queue lands (BL-218), the privacy contact works from those emails and records the outcome in the database as `fr_migrator`:

```sql
-- Open requests, oldest due first.
select reference, category, created_at, due_at, user_id from user_grievances where status = 'open' order by due_at;
-- After answering by email.
update user_grievances set status = 'answered' where reference = 'GRV-XXXXXXXX';
-- When nothing more will happen.
update user_grievances set status = 'closed', closed_at = now() where reference = 'GRV-XXXXXXXX';
```

- **Answer within 90 days**, sooner when possible; the receipt already promised the date.
- **Confirm identity by replying to the account's address**, never to another address the request names.
- **Nominations** (s.14): record the nominee's name and contact in the reply thread and on the request; act on a nomination only with proof of death or incapacity.
- **Requests about org data** (forms, responses): reply that the org owns them, and name the org's owners if the user is a member.

## When deletion is blocked

`POST /v1/me/delete` refuses while the user is the only owner of an org, the only member of one, or owns forms in an org that has no other owner (`ACCOUNT_DELETION_BLOCKED`). The account's Privacy page says which org and why. The user (or another member) makes someone else an owner, or the org is deleted (CMP-17); then the deletion goes through. Ownership transfer and org deletion in the builder arrive with WP-1.02 (BL-213); until then the operator can make a member an owner on request, after confirming it with that member.

## What deletion does

In one transaction (`account_delete()`): the user leaves every org; forms they owned pass to the longest-standing other owner of that org; every session, linked Google or Microsoft account and emailed link goes; open requests close without their message; the user row becomes a tombstone (`deleted-<id>@deleted.invalid`, no name, no credentials). Audit records, the edit history of forms and the record of which notice was shown keep pointing at the now pseudonymous id. Backups expire within 35 days; the confirmation email says by when. The address is free to sign up again, as a new account.

## Complaints to the Board

If the user is not satisfied, they may complain to the Data Protection Board of India; the notice says so. Keep the request's thread and outcome for at least the audit retention (13 months online).
