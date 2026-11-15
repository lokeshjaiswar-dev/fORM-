import { useRef, type KeyboardEvent } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { FORMS_PANEL_ID, formsTabId } from '@/pages/forms/panelIds';
import { FORM_LIFECYCLES, type FormLifecycle } from '@/persistence/formsListApi';

const M = defineMessages('builder', {
  'forms.tabs': 'Folders',
  'forms.tab_active': 'Active',
  'forms.tab_archived': 'Archived',
  'forms.tab_trash': 'Trash',
});

const LABELS: Record<FormLifecycle, MessageId> = {
  active: M['forms.tab_active'],
  archived: M['forms.tab_archived'],
  trashed: M['forms.tab_trash'],
};

export interface FormsTabsProps {
  value: FormLifecycle;
  onChange: (lifecycle: FormLifecycle) => void;
}

/**
 * Active, Archived and Trash as tabs. One tab is in the tab order and the arrow keys, Home and End move between them
 * (the pattern of the Responses folders), so the list's own controls are not buried behind three stops.
 */
export function FormsTabs({ value, onChange }: FormsTabsProps) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = FORM_LIFECYCLES.indexOf(value);
    const last = FORM_LIFECYCLES.length - 1;
    const next = event.key === 'ArrowRight' ? (at + 1) % FORM_LIFECYCLES.length : event.key === 'ArrowLeft' ? (at + last) % FORM_LIFECYCLES.length : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    const target = FORM_LIFECYCLES[next];
    if (target) onChange(target);
    tabs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={t(M['forms.tabs'])} onKeyDown={onKeyDown} className="flex gap-1 border-b border-border">
      {FORM_LIFECYCLES.map((name, index) => {
        const selected = name === value;
        return (
          <button
            key={name}
            ref={(el) => {
              tabs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={formsTabId(name)}
            aria-selected={selected}
            aria-controls={FORMS_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(name)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[14px] font-medium',
              selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(LABELS[name])}
          </button>
        );
      })}
    </div>
  );
}
