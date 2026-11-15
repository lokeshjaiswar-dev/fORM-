import type { View } from '@/persistence/submissionsApi';

/** The element ids that tie each folder tab to the panel the page draws under it. */
export const PANEL_ID = 'responses-panel';
export const tabId = (view: View): string => `responses-tab-${view}`;
