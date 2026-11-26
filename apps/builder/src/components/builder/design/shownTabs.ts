import type { ProfileName } from '@/embed/launch';
import { useProfile } from '@/embed/useProfile';

/** Form settings tabs that can be hidden. A hidden tab's settings, and any form that already uses them, are untouched. */
export interface ShownDesignTabs {
  /** Rules: show, hide and require questions by condition. */
  logic: boolean;
  /** Sections: the section navigator and how the current section is marked. */
  sections: boolean;
  /** API autofill (Fill from master in the Masters builder): fill questions from a lookup. */
  lookup: boolean;
}

const ALL: ShownDesignTabs = { logic: true, sections: true, lookup: true };

/** A master has no rules and no sections (DMS forms have neither); its lookup tab is Fill from master. */
const MASTERS: ShownDesignTabs = { logic: false, sections: false, lookup: true };

export const shownDesignTabs = (profile: ProfileName): ShownDesignTabs => (profile === 'dms-v1' ? MASTERS : ALL);

export const useShownDesignTabs = (): ShownDesignTabs => shownDesignTabs(useProfile());
