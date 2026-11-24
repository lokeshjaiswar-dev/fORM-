import { createContext, useContext, type ReactNode } from 'react';
import type { ProfileName } from '@/embed/launch';

/**
 * Which field profile the builder runs: `full` (today's builder, the default) or `dms-v1` (the seven field types DMS+
 * supports, set by a launch descriptor on an `/embed/dms-*` route or by the dev override). It decides what the palette
 * and slash menu offer and which inspector tabs show; the schema guard (`checkDmsV1`) is what stops anything else saving.
 */
const ProfileCtx = createContext<ProfileName>('full');

export function ProfileProvider({ profile, children }: { profile: ProfileName; children: ReactNode }) {
  return <ProfileCtx.Provider value={profile}>{children}</ProfileCtx.Provider>;
}

export const useProfile = (): ProfileName => useContext(ProfileCtx);
