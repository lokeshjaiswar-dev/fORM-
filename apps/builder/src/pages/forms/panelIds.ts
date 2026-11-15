import type { FormLifecycle } from '@/persistence/formsListApi';

/** The id of the panel the folder tabs control: the list under them. */
export const FORMS_PANEL_ID = 'forms-panel';
export const formsTabId = (lifecycle: FormLifecycle): string => `forms-tab-${lifecycle}`;
