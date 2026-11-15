import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import type { SettingsPanelProps } from '@/components/settings/types';

const M = defineMessages('builder', {
  'settings_notifications.title': 'Email notifications',
  'settings_notifications.coming_soon': 'The emails sent when someone submits this form will be set up here.',
});

/**
 * The "Emails" tab of a form's settings: its notifications and autoresponders (WP-1.16). A placeholder until the
 * notifications UI replaces this file; `FormSettingsPage` already mounts it with the form id.
 */
export function NotificationsPanel(_props: SettingsPanelProps) {
  return (
    <div>
      <h2 className="text-[18px] font-semibold">{t(M['settings_notifications.title'])}</h2>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['settings_notifications.coming_soon'])}</p>
    </div>
  );
}
