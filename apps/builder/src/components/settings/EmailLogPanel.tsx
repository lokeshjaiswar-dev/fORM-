import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import type { SettingsPanelProps } from '@/components/settings/types';

const M = defineMessages('builder', {
  'settings_email_log.title': 'Email log',
  'settings_email_log.coming_soon': 'The emails this form has sent, and whether they arrived, will be listed here.',
});

/**
 * The "Email log" tab of a form's settings (WP-1.16). A placeholder until the notifications UI replaces this file;
 * `FormSettingsPage` already mounts it with the form id.
 */
export function EmailLogPanel(_props: SettingsPanelProps) {
  return (
    <div>
      <h2 className="text-[18px] font-semibold">{t(M['settings_email_log.title'])}</h2>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['settings_email_log.coming_soon'])}</p>
    </div>
  );
}
