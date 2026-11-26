import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { switchBuilderView } from '@/lib/viewTransition';
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

/** Where the selected tab sits in the track, in px from the track's left and right edges. */
interface PillBox {
  left: number;
  right: number;
}

/* The tab box, shared by the buttons and the dark copy of their labels so the two line up exactly. */
const TAB_BOX = 'flex min-h-7 items-center justify-center rounded-[4px] px-4 py-1.5 text-[12px] font-semibold leading-4 whitespace-nowrap';

/**
 * The segmented control in the top bar (Figma Tabs, filled): a raised light pill on a dark track. Edit and Preview
 * still navigate, so the URL stays the only source of the mode (B23); Settings opens the form settings panel.
 *
 * The pill glides to the selected tab. The labels are drawn twice: light on the track, and a dark copy on top clipped
 * to the pill, which glides with it, so text inside the pill is always dark and text outside it always light, even
 * halfway through a move.
 */
export function ViewTabs() {
  const [mode, setMode] = useBuilderMode();
  const designOpen = useUiStore((s) => s.designOpen);
  const setDesignOpen = useUiStore((s) => s.setDesignOpen);
  const active: View = designOpen ? 'settings' : mode;
  const track = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<PillBox | null>(null);

  /* Measured, not assumed: the labels' widths depend on the font. A new pill appears in place; later moves glide. */
  useLayoutEffect(() => {
    const measure = () => {
      const button = buttons.current[active];
      const box = track.current;
      if (!button || !box) return;
      const next = { left: button.offsetLeft, right: box.offsetWidth - button.offsetLeft - button.offsetWidth };
      /* No re-render when nothing moved (the observer also fires once on start). */
      setPill((prev) => (prev && prev.left === next.left && prev.right === next.right ? prev : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function' || !track.current) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(track.current);
    return () => observer.disconnect();
  }, [active]);

  const choose = (view: View) => {
    if (view === active) return;
    switchBuilderView(() => {
      if (view === 'settings') {
        setDesignOpen(true);
        return;
      }
      setDesignOpen(false);
      setMode(view);
    }, view);
  };

  const pillStyle: CSSProperties | undefined = pill ? { left: pill.left, right: pill.right } : undefined;
  const clipStyle: CSSProperties | undefined = pill ? { clipPath: `inset(2px ${pill.right}px 2px ${pill.left}px round 4px)` } : undefined;

  return (
    <div ref={track} role="group" aria-label="Builder view" className="relative flex gap-0.5 rounded-[6px] bg-(--bluedark-1100) p-0.5">
      {pill ? (
        <span
          aria-hidden="true"
          className="view-tabs-pill pointer-events-none absolute inset-y-0.5 rounded-[4px] bg-(--bluedark-050) shadow-[0_2px_8px_rgba(0,0,0,0.32)]"
          style={pillStyle}
        />
      ) : null}
      {VIEWS.map((view) => {
        const selected = active === view.id;
        return (
          <button
            key={view.id}
            ref={(el) => {
              buttons.current[view.id] = el;
            }}
            type="button"
            aria-pressed={selected}
            aria-label={view.ariaLabel}
            onClick={() => choose(view.id)}
            className={cn(
              TAB_BOX,
              'relative text-sidebar-muted outline-none transition-colors duration-150',
              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring',
              !selected && 'hover:bg-sidebar-border hover:text-sidebar-foreground',
            )}
          >
            {view.label}
          </button>
        );
      })}
      {pill ? (
        <div aria-hidden="true" className="view-tabs-pill pointer-events-none absolute inset-0 flex gap-0.5 p-0.5 text-(--bluedark-1200)" style={clipStyle}>
          {VIEWS.map((view) => (
            <span key={view.id} className={TAB_BOX}>
              {view.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
