import type { RemoteSource } from '@form/renderer';
import type { PublicLookup } from '@form/schema';
import { createDmsClient, type DmsClient } from '@/embed/dmsClient';
import { currentLaunch } from '@/embed/launch';
import { dmsDirectRemoteSource } from '@/embed/lookup/dmsDirectRemoteSource';

/**
 * The builder preview's source for "Fill from master" (`dms_master`) lookups (contract section 6): the master builder was
 * opened from DMS with the user's token, so the preview asks dms-api itself, exactly as `/embed/dms-record` does (same
 * projection, same hidden and secret drops). null when the form has no such lookup or the page has no DMS launch, in which
 * case the preview says it does not run them.
 */
export function previewDmsSource(lookups: readonly PublicLookup[] | undefined, client?: Pick<DmsClient, 'request'>): RemoteSource | null {
  const dms = (lookups ?? []).filter((l) => l.source === 'dms_master');
  if (dms.length === 0) return null;
  let api = client;
  if (!api) {
    const launch = currentLaunch('dms-master');
    if (!launch.ok) return null;
    api = createDmsClient({ apiBase: launch.launch.apiBase, tenantId: launch.launch.tenantId, workspaceId: launch.launch.workspaceId });
  }
  return dmsDirectRemoteSource(api, dms);
}
