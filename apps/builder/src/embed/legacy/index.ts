import type { HandoffEnv } from '@/embed/session/handoff';
import type { LaunchMode, LegacyOutcome } from '@/embed/session/launchTypes';
import { resumeFromStorage, startFromFragment } from './descriptor';

/*
 * The one entry `session/launchFlow.ts` imports (dynamically, behind VITE_FP_LEGACY_DESCRIPTOR=1). It brings in the `#fp=` parser, the
 * legacy transport and the cookie reader; a default build has none of them.
 */

export const startLegacyLaunch = (mode: LaunchMode, fragment: string, env: HandoffEnv): Promise<LegacyOutcome> => Promise.resolve(startFromFragment(mode, fragment, env));

export const resumeLegacyLaunch = (mode: LaunchMode, env: HandoffEnv): Promise<LegacyOutcome | null> => Promise.resolve(resumeFromStorage(mode, env));
