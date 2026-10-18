import type { IsoInstant } from './common.ts';

/** Submissions are partitioned by time, so every reference carries `receivedAt` (architecture §2.4). */
export interface SubmissionKey {
  submissionId: string;
  receivedAt: IsoInstant;
}

/** Text of non-sensitive answers only; sensitive fields are searchable through blind indexes, never here. */
export interface SearchDocument extends SubmissionKey {
  formId: string;
  locale: string;
  text: string[];
}

export interface SearchQuery {
  formId: string;
  text: string;
  limit: number;
  /** Opaque cursor from the previous page. */
  after?: string;
}

export interface SearchHit extends SubmissionKey {
  rank: number;
}

/** Postgres FTS in every edition (architecture §6); every call is scoped to one org. */
export interface SearchIndex {
  upsert(orgId: string, docs: readonly SearchDocument[]): Promise<void>;
  remove(orgId: string, keys: readonly SubmissionKey[]): Promise<void>;
  query(orgId: string, q: SearchQuery): Promise<{ hits: SearchHit[]; next?: string }>;
}
