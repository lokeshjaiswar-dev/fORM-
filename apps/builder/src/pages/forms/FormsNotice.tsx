import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import type { Notice } from '@/pages/forms/useFormActions';

const M = defineMessages('builder', {
  'forms.dismiss': 'Dismiss',
});

/**
 * What the last action did ("“Feedback” was moved to the trash."), with the one thing to do about it (Undo, Open). The
 * region is always on the page, so a screen reader announces the text when it appears.
 */
export function FormsNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite" className={notice ? 'mt-4 flex items-center gap-2 rounded-[8px] bg-state-hover px-3 py-2 text-[14px]' : undefined}>
      {notice ? (
        <>
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action ? (
            'to' in notice.action ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={notice.action.to}>{notice.action.label}</Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={notice.action.run}>
                {notice.action.label}
              </Button>
            )
          ) : null}
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['forms.dismiss'])} onClick={onDismiss}>
            <X className="size-4" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
