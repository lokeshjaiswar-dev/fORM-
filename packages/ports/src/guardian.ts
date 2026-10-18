export const GUARDIAN_METHODS = ['existing_verified_adult_account', 'manual_document_review', 'digilocker_token'] as const;
export type GuardianMethod = (typeof GUARDIAN_METHODS)[number];

export interface GuardianStartInput {
  orgId: string;
  submissionId: string;
  guardianEmail: string;
}

export interface GuardianStart {
  /** Correlates `complete`; opaque and unguessable. */
  verificationId: string;
  next: 'email_link' | 'redirect' | 'review_queue';
  url?: string;
}

export interface GuardianCompleteInput {
  verificationId: string;
  /** Method-specific; implementations validate it and reject anything else with PortError('invalid_argument'). */
  payload: unknown;
}

/**
 * Verifiable parental consent (CMP-13, CMP-22). An unknown id → PortError('not_found'); completing an id
 * twice → PortError('conflict'), so evidence cannot be replayed.
 */
export interface GuardianVerifier {
  readonly method: GuardianMethod;
  start(i: GuardianStartInput): Promise<GuardianStart>;
  complete(i: GuardianCompleteInput): Promise<{ verified: boolean; evidenceRef: string }>;
}
