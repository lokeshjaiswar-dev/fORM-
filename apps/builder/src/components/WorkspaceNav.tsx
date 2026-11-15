import { Link, useLocation } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useActiveOrg } from '@/auth/client';
import { useMayReview } from '@/components/review/useMayReview';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'nav.forms': 'Forms',
  'nav.fields': 'Fields',
  'nav.reviews': 'Reviews',
});

/** List-page tabs: saved forms, the custom field library and, for a member whose role may check responses, the review queue. */
export function WorkspaceNav() {
  const path = useLocation().pathname;
  const mayReview = useMayReview(useActiveOrg()?.id ?? null);
  const items = [
    { to: '/forms', label: t(M['nav.forms']), active: path.startsWith('/forms') },
    { to: '/fields', label: t(M['nav.fields']), active: path.startsWith('/fields') },
    ...(mayReview ? [{ to: '/reviews', label: t(M['nav.reviews']), active: path.startsWith('/reviews') }] : []),
  ];
  return (
    <nav aria-label="Workspace" className="mb-4 flex gap-1">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? 'page' : undefined}
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
