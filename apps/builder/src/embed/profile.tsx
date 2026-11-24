import { createContext, useContext, useState, type ReactNode } from 'react';
import { profileOverride, type ProfileName } from '@/embed/launch';

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

/**
 * The profile of the normal (standalone) builder: `full`, unless this is a dev build (`VITE_FP_DEV_OVERRIDES=1`) opened
 * with `?fp_profile=dms-v1`, which shows the seven-type palette so developers can see it without a DMS launch. Read
 * once at mount. In a production build the override is never honoured, and `/embed/dms-*` sets its own profile.
 */
export function DevProfileProvider({ children, search }: { children: ReactNode; search?: string }) {
  const [profile] = useState<ProfileName>(() => profileOverride(search ?? globalThis.location?.search ?? '') ?? 'full');
  return <ProfileProvider profile={profile}>{children}</ProfileProvider>;
}
