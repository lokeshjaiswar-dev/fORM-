import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'forms.untitled': 'Untitled form',
});

/** What a form is called in a list, a button's name or a message: its title, or a stand-in while it has none. */
export const rowTitle = (form: { title: string }): string => form.title || t(M['forms.untitled']);
