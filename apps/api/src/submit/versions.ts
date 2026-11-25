import { and, eq } from 'drizzle-orm';
import { formVersionState, type Tx } from '@form/db';

/**
 * Which version a respondent's request may name (F-34): the live one, or the one it replaced for `accept_previous_versions_hours`
 * after the newer one went live, unless it was retired. One copy, used by the submit pipeline and by the lookup proxy, so a
 * respondent whose page was built from the previous version is served by that version's own stored config for exactly as long
 * as it may still submit to it. The page names the version; the server decides.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/** The dates of a version that is not the live one; null when the form has no such version. */
export interface NamedVersionState {
  supersededAt: Date | null;
  retiredAt: Date | null;
}

/** Reads the dates of `versionId` of `formId`, in the caller's (respondent) tenant transaction. */
export async function readNamedVersionState(tx: Tx, formId: string, versionId: string): Promise<NamedVersionState | null> {
  const [state] = await tx
    .select({ supersededAt: formVersionState.supersededAt, retiredAt: formVersionState.retiredAt })
    .from(formVersionState)
    .where(and(eq(formVersionState.versionId, versionId), eq(formVersionState.formId, formId)))
    .limit(1);
  return state ?? null;
}

/** Whether a version that is not live still takes requests at `at`: superseded, not retired, and inside the window. */
export function isPreviousVersionAccepted(state: NamedVersionState | null, acceptPreviousVersionsHours: number, at: Date): boolean {
  return state !== null && state.retiredAt === null && state.supersededAt !== null && at.getTime() - state.supersededAt.getTime() < acceptPreviousVersionsHours * MS_PER_HOUR;
}
