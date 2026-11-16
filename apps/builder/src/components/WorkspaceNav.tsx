import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'nav.forms': 'Forms',
  'nav.fields': 'Fields',
});

/** List-page tabs: saved forms and the custom field library. */
export function WorkspaceNav() {
  const path = useLocation().pathname;
  const navigate = useNavigate();
  const active = path.startsWith('/fields') ? '/fields' : '/forms';
  return (
    <Tabs value={active} onValueChange={(to) => navigate(to)} className="mb-4">
      <TabsList aria-label="Workspace">
        <TabsTrigger value="/forms">{t(M['nav.forms'])}</TabsTrigger>
        <TabsTrigger value="/fields">{t(M['nav.fields'])}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
