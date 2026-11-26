import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

interface GlideBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The class that lets a selected tab show the glide instead of its own background (pill tabs from @dmacq/ui). */
export const GLIDE_TRIGGER = 'relative data-[state=active]:bg-transparent data-[state=active]:shadow-none';

/**
 * The selected-tab highlight of a pill tab list, as one element that glides from tab to tab instead of jumping.
 * Put it first inside the tab list (which must be `relative`), pass the selected tab as `active`, and give the tabs
 * `relative` with no selected background (`GLIDE_TRIGGER` for @dmacq/ui triggers) so their labels sit above it.
 * It measures the list's selected tab (`aria-selected="true"`), so it follows font and panel resizes too.
 */
export function TabGlide({ active, className }: { active: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<GlideBox | null>(null);
  /* A move caused by the list resizing (say the settings panel being dragged wider) follows at once, not 420 ms behind. */
  const [instant, setInstant] = useState(false);
  const last = useRef<GlideBox | null>(null);

  useLayoutEffect(() => {
    const list = ref.current?.parentElement;
    if (!list) return undefined;
    const measure = (fromResize: boolean) => {
      const tab = list.querySelector<HTMLElement>(':scope > [role="tab"][aria-selected="true"]');
      if (!tab) return;
      const next = { left: tab.offsetLeft, top: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight };
      const prev = last.current;
      if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) return;
      last.current = next;
      setInstant(fromResize);
      setBox(next);
    };
    measure(false);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(list);
    return () => observer.disconnect();
  }, [active]);

  /* The first placement only puts the highlight under its tab; gliding starts from the next frame on. */
  const [glides, setGlides] = useState(false);
  useEffect(() => {
    if (!box || glides) return undefined;
    const id = requestAnimationFrame(() => setGlides(true));
    return () => cancelAnimationFrame(id);
  }, [box, glides]);

  /* Moved with a transform, which the compositor animates even while the newly picked tab's content is rendering. */
  const style: CSSProperties = box
    ? { transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height }
    : { visibility: 'hidden' };
  return <span ref={ref} aria-hidden="true" className={cn('pointer-events-none absolute left-0 top-0', glides && !instant && 'tab-glide', className)} style={style} />;
}
