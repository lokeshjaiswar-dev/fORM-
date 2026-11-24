import { createContext, useContext } from 'react';
import type { ProfileName } from '@/embed/launch';

/** The field profile the builder runs (see `profile.tsx`): `full` (today's builder, the default) or `dms-v1`. */
export const ProfileCtx = createContext<ProfileName>('full');

export const useProfile = (): ProfileName => useContext(ProfileCtx);
