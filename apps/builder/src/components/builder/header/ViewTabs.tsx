import { cn } from '@/lib/utils';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { useUiStore } from '@/state/uiStore';

type View = 'edit' | 'preview' | 'settings';

interface ViewTab {
  id: View;
  label: string;
  /** Accessible name when it says more than the label; it always contains the label. */
  ariaLabel?: string;
}

const VIEWS: readonly ViewTab[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'preview', label: 'Preview' },
  { id: 'settings', label: 'Settings', ariaLabel: 'Form settings' },
];

/**
 * The segmented control in the top bar (Figma Tabs, filled): a raised light pill on a dark track. Edit and Preview
 * still navigate, so the URL stays the only source of the mode (B23); Settings opens the form settings panel.
 */
export function ViewTabs() {
  const [mode, setMode] = useBuilderMode();
  const designOpen = useUiStore((s) => s.designOpen);
  const setDesignOpen = useUiStore((s) => s.setDesignOpen);
  const active: View = designOpen ? 'settings' : mode;

  const choose = (view: View) => {
    if (view === 'settings') {
      setDesignOpen(true);
      return;
    }
    setDesignOpen(false);
    setMode(view);
  };

  return (
    <div role="group" aria-label="Builder view" className="flex gap-0.5 rounded-[6px] bg-(--bluedark-1100) p-0.5">
      {VIEWS.map((view) => {
        const selected = active === view.id;
        return (
          <button
            key={view.id}
            type="button"
            aria-pressed={selected}
            aria-label={view.ariaLabel}
            onClick={() => choose(view.id)}
            className={cn(
              'flex min-h-7 items-center justify-center rounded-[4px] px-4 py-1.5 text-[12px] font-semibold leading-4 whitespace-nowrap outline-none transition-colors duration-150',
              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring',
              selected
                ? 'bg-(--bluedark-050) text-(--bluedark-1200) shadow-[0_2px_8px_rgba(0,0,0,0.32)]'
                : 'text-sidebar-muted hover:bg-sidebar-border hover:text-sidebar-foreground',
            )}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}
