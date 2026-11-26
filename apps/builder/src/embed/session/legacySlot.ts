import type { DmsClient, DmsClientOptions } from './clientTypes';
import type { LaunchMode, ResolvedLaunch } from './launchTypes';

/*
 * Where the M2 legacy build (`VITE_FP_LEGACY_DESCRIPTOR=1`, SEC-DESIGN 1.12) plugs in. In a default build nothing ever fills it: the
 * legacy modules (`embed/legacy/**`, the `#fp=` parser and the cookie reader) are reached only by a dynamic import behind the flag, so
 * they are not in the bundle, and these three variables stay empty.
 */

const launches = new Map<LaunchMode, ResolvedLaunch>();
let clientFactory: ((options: DmsClientOptions) => DmsClient) | null = null;
let masterIdHook: ((mode: LaunchMode, masterId: string) => void) | null = null;

export const legacyLaunchOf = (mode: LaunchMode): ResolvedLaunch | undefined => launches.get(mode);
export const legacyClientFactory = (): ((options: DmsClientOptions) => DmsClient) | null => clientFactory;
export const legacyMasterIdHook = (): ((mode: LaunchMode, masterId: string) => void) | null => masterIdHook;

/** Called by `embed/legacy` once a `#fp=` launch has been validated. */
export function installLegacy(parts: { launch: ResolvedLaunch; client: (options: DmsClientOptions) => DmsClient; onMasterId: (mode: LaunchMode, masterId: string) => void }): void {
  launches.set(parts.launch.mode, parts.launch);
  clientFactory = parts.client;
  masterIdHook = parts.onMasterId;
}

/** A create gave the legacy launch's master an id: the kept copy now says "edit that master". */
export function updateLegacyLaunch(mode: LaunchMode, next: ResolvedLaunch): void {
  launches.set(mode, next);
}

export function resetLegacySlot(): void {
  launches.clear();
  clientFactory = null;
  masterIdHook = null;
}
