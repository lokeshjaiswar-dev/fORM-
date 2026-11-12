import { Link, useLocation } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'nav.forms': 'Forms',
  'nav.fields': 'Fields',
});

/** List-page tabs: saved forms and the custom field library. */
export function WorkspaceNav() {
  const path = useLocation().pathname;
  const items = [
    { to: '/forms', label: t(M['nav.forms']), active: path.startsWith('/forms') },
    { to: '/fields', label: t(M['nav.fields']), active: path.startsWith('/fields') },
  ];
  return (
    <nav aria-label="Workspace" className="mb-4 flex gap-1">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(
            'rounded-[6px] px-3 py-1.5 text-[14px] font-medium',
            item.active ? 'bg-state-hover text-foreground' : 'text-muted-foreground hover:bg-state-hover hover:text-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
