import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import type { SettingsPanelProps } from '@/components/settings/types';

const M = defineMessages('builder', {
  'settings_webhooks.title': 'Webhooks',
  'settings_webhooks.coming_soon': 'The web addresses that receive each response will be set up here.',
});

/**
 * The "Webhooks" tab of a form's settings (WP-1.18). A placeholder until the webhooks UI replaces this file;
 * `FormSettingsPage` already mounts it with the form id.
 */
export function WebhooksPanel(_props: SettingsPanelProps) {
  return (
    <div>
      <h2 className="text-[18px] font-semibold">{t(M['settings_webhooks.title'])}</h2>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['settings_webhooks.coming_soon'])}</p>
    </div>
  );
}
