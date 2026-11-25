import { eq } from 'drizzle-orm';
import { secrets, type Tx } from '@form/db';
import { jsonPointer, type CredentialRef, type FormDefinition } from '@form/schema';
import type { PipelineIssue } from './issues.ts';

/**
 * The publish checks of server-side lookups that need the database or the kind of publish (the pure ones are in
 * `validateStructure`): `credential_missing` (a `credentialRef` that is not an api_credential of this org) and
 * `lookup_source_not_allowed` (a `dms_master` lookup in a standalone publish: DMS answers those, never this API).
 */

/** The ids of the org's API credentials, as the caller may list them (a publisher is a forms author). */
export async function credentialIdsOf(tx: Tx): Promise<Set<string>> {
  const rows = await tx.select({ id: secrets.id }).from(secrets).where(eq(secrets.kind, 'api_credential'));
  return new Set(rows.map((r) => r.id));
}

export function lookupIssues(def: FormDefinition, credentialIds: ReadonlySet<string> | undefined): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const credential = (ref: CredentialRef | undefined, path: string) => {
    if (ref !== undefined && credentialIds !== undefined && !credentialIds.has(ref.secretId)) {
      issues.push({ severity: 'error', code: 'credential_missing', path, message: 'this API credential does not exist in this organisation; choose another or remove it' });
    }
  };
  def.lookups?.forEach((lookup, i) => {
    if (lookup.source === 'dms_master') {
      issues.push({ severity: 'error', code: 'lookup_source_not_allowed', path: jsonPointer('lookups', i, 'source'), message: 'a DMS master lookup only works in a form that DMS hosts' });
    } else credential(lookup.credentialRef, jsonPointer('lookups', i, 'credentialRef'));
  });
  if (def.lookup) credential(def.lookup.credentialRef, jsonPointer('lookup', 'credentialRef'));
  for (const [id, block] of Object.entries(def.blocks)) {
    const field = block as { apiOptions?: { credentialRef?: CredentialRef }; apiValidation?: { credentialRef?: CredentialRef } } | undefined;
    credential(field?.apiOptions?.credentialRef, jsonPointer('blocks', id, 'apiOptions', 'credentialRef'));
    credential(field?.apiValidation?.credentialRef, jsonPointer('blocks', id, 'apiValidation', 'credentialRef'));
  }
  return issues;
}
