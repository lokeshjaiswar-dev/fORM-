import type { AuditOutcome } from '../schema/index.ts';

export interface AuditEventSpec {
  /** The outcomes this action is recorded with; `success` goes in the business transaction, the others detached. */
  outcomes: readonly AuditOutcome[];
  resourceType: string;
  description: string;
}

/**
 * Every audit action the platform emits (architecture §2.7). `audit.append()` accepts only these codes, and
 * `catalogue.test.ts` checks that each emitting call site names one and that each entry is emitted somewhere.
 * Later work packages add their codes here (auth, membership, publish, FormOps, DSR, templates, …).
 */
export const AUDIT_EVENTS = {
  'request.authorize': {
    outcomes: ['denied'],
    resourceType: 'route',
    description: 'An API request was refused with 403: the caller is not a member of the org, or lacks the permission.',
  },
  'request.failed': {
    outcomes: ['error'],
    resourceType: 'route',
    description: 'An API request failed with a 5xx; the problem code is the reason.',
  },
  'auth.signup': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'An account was created (pending email verification); denied when the address is taken or sign-up is refused.',
  },
  'auth.email_verified': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'An email verification link was redeemed; denied for an unknown, used or expired link, or a missing or wrong password in another browser.',
  },
  'auth.login': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'A session was issued (method and factors in metadata); denied for a refused password, link, OAuth answer or second factor.',
  },
  'auth.mfa_challenged': {
    outcomes: ['success'],
    resourceType: 'user',
    description: 'The first factor passed and a 5-minute MFA ticket was issued; the session follows the second factor.',
  },
  'auth.logout': {
    outcomes: ['success'],
    resourceType: 'session',
    description: 'The user signed out; the session was revoked (there is none with the development header).',
  },
  'auth.magic_link_sent': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description:
      'A sign-in link was emailed (reason step_up after many password attempts at the account); denied when no active account has the address (the caller sees the same answer).',
  },
  'auth.link_checked': {
    outcomes: ['denied'],
    resourceType: 'user',
    description: 'An emailed sign-in or verification link was looked up before use and is unknown, used or expired.',
  },
  'auth.password_reset_requested': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'A password reset link was emailed; denied when no active account has the address (the caller sees the same answer).',
  },
  'auth.password_reset': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'A password was reset with an emailed link and every session revoked; denied for a bad link or a refused password.',
  },
  'auth.totp_setup': {
    outcomes: ['success'],
    resourceType: 'user',
    description: 'A new TOTP secret was issued for enrolment; it takes effect once a code from it is verified.',
  },
  'auth.totp_enabled': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'TOTP two-factor sign-in was turned on and 10 recovery codes issued; denied for a wrong code or a sign-in older than 15 minutes.',
  },
  'auth.totp_disabled': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'TOTP two-factor sign-in was turned off and the recovery codes discarded; denied for a wrong code.',
  },
  'auth.recovery_codes_issued': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description: 'A fresh set of 10 recovery codes replaced the old ones; denied for a wrong TOTP code.',
  },
  'auth.session_rotated': {
    outcomes: ['success'],
    resourceType: 'session',
    description: 'A privilege change (second factor added or removed) replaced the session token; the old one was revoked.',
  },
  'auth.session_revoked': {
    outcomes: ['success'],
    resourceType: 'session',
    description: 'The user revoked one of their sessions, or every other session after a credential change.',
  },
  'auth.session_rejected': {
    outcomes: ['denied'],
    resourceType: 'session',
    description: 'A request carried a session cookie that is unknown, revoked or expired, or whose user is no longer active.',
  },
  'auth.oauth_linked': {
    outcomes: ['success'],
    resourceType: 'user',
    description: 'A Google or Microsoft account was linked to the user at OAuth sign-in (the provider in metadata).',
  },
  'auth.throttled': {
    outcomes: ['denied'],
    resourceType: 'route',
    description: 'An auth limit was reached (bucket in metadata): refused with 429, or for auth_account stepped up to an emailed link.',
  },
  'account.notice_acknowledged': {
    outcomes: ['success'],
    resourceType: 'user',
    description:
      'The user was shown a version of the platform privacy notice (CMP-21): at sign-up, first OAuth sign-in or in settings (version, hash, context in metadata).',
  },
  'account.profile_updated': {
    outcomes: ['success'],
    resourceType: 'user',
    description: 'The user corrected their own profile (which columns changed in metadata, never the values).',
  },
  'account.exported': {
    outcomes: ['success'],
    resourceType: 'user',
    description: 'The user downloaded the export of their own account data (CMP-21).',
  },
  'account.deleted': {
    outcomes: ['success', 'denied'],
    resourceType: 'user',
    description:
      'The user deleted their account: memberships, sessions and credentials gone, forms passed to an org owner (counts in metadata); denied while an org would be left without an owner or members, or for a stale sign-in or a wrong confirmation.',
  },
  'account.grievance_filed': {
    outcomes: ['success'],
    resourceType: 'grievance',
    description:
      'A builder user sent a privacy request or grievance to the platform privacy contact (category and due date in metadata, never the message).',
  },
  'job.rejected': {
    outcomes: ['denied'],
    resourceType: 'job',
    description: 'A job envelope failed verification (signature, scope, org re-derivation) and was dead-lettered unrun.',
  },
  'system.heartbeat': {
    outcomes: ['success'],
    resourceType: 'org',
    description: 'The worker made one round trip inside the tenant.',
  },
  'audit.verified': {
    outcomes: ['success', 'error'],
    resourceType: 'audit_chain',
    description: 'audit.verify checked the chain (hashes, links, head, checkpoint signatures); error names the first problem.',
  },
  'audit.archived': {
    outcomes: ['success'],
    resourceType: 'audit_chain',
    description: 'audit.archive exported one month of the chain to the audit bucket before the partition is detached.',
  },
  'submission.viewed': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'A submission detail view (C-M9: every read, for every form).',
  },
  'submission.page_viewed': {
    outcomes: ['success'],
    resourceType: 'form',
    description: 'One page of the submissions grid, coalesced: the ids shown, never the values.',
  },
  'submission.api_read': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Submissions read through the API.',
  },
  'submission.revealed': {
    outcomes: ['success'],
    resourceType: 'submission',
    description: 'Masked sensitive values revealed (reveal=1); the field ids, never the values.',
  },
  'submission.exported': {
    outcomes: ['success'],
    resourceType: 'export',
    description: 'A submissions export was requested; includeSensitive needs a reason.',
  },
  'file.downloaded': {
    outcomes: ['success'],
    resourceType: 'file',
    description: 'A file attached to a submission was downloaded.',
  },
} as const satisfies Record<string, AuditEventSpec>;

export type AuditAction = keyof typeof AUDIT_EVENTS;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

export function isAuditAction(v: unknown): v is AuditAction {
  return typeof v === 'string' && Object.hasOwn(AUDIT_EVENTS, v);
}
