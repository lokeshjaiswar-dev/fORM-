import type { Classification } from '@/embed/contract';

/*
 * The shapes the pages know a launch by. They live here, in a module with no runtime imports, so `launch.ts` (which pages import
 * them from) and the session and legacy modules can all use them without importing one another in a circle.
 */

export const LAUNCH_MODES = ['dms-master', 'dms-upload', 'dms-record'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type ProfileName = 'full' | 'dms-v1';

/**
 * The `#fp=` descriptor of the legacy launch (M2 build only, `embed/legacy/descriptor.ts`). Kept as a type because `ResolvedLaunch`
 * is derived from it and older callers still name it. A default build never parses one.
 */
export interface LaunchDescriptor {
  v: 1;
  mode: LaunchMode;
  profile: 'dms-v1';
  tenantId: string;
  workspaceId: string;
  masterId?: string | undefined;
  recordId?: string | undefined;
  slug?: string | undefined;
  master?:
    | {
        name: string;
        doctypeIds: string[];
        folderIds: string[];
        /** Set from the ticket's `master_seed` on a create; the legacy descriptor only ever carried null. */
        classification?: Classification | null | undefined;
      }
    | undefined;
  returnUrl: string;
  apiBase: string;
}

/**
 * What a page learns about its launch. Built from the exchange context (`session/dmsSession.ts`); `tenantId` and `workspaceId` are
 * for display only (fORM- never sends them). `returnUrl` is null when it is not on this build's allowlist.
 */
export interface ResolvedLaunch extends Omit<LaunchDescriptor, 'returnUrl' | 'apiBase'> {
  /** dms-api base, absolute, no trailing slash: the allowlisted `VITE_FP_DMS_API_BASE` the session was exchanged with. */
  apiBase: string;
  returnUrl: string | null;
}

/** Why the M2 legacy build refused a `#fp=` launch (`embed/legacy`). */
export type LegacyFailure = 'malformed' | 'invalid' | 'wrong_mode' | 'api_not_allowed';
export type LegacyOutcome = { kind: 'legacy' } | { kind: 'failed'; reason: LegacyFailure };
