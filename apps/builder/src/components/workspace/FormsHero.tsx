/**
 * Decorative banner for the forms list: an animated SVG form blueprint. The strokes draw in once on mount and the
 * sheet floats gently. Purely visual; it carries no text and is hidden from assistive technology.
 */
export function FormsHero() {
  return (
    <div className="ws-enter relative overflow-hidden rounded-[12px] border border-border bg-surface-subtle">
      <svg
        viewBox="0 0 960 140"
        className="absolute inset-0 size-full text-primary/[0.09]"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
        focusable="false"
      >
        <g className="ws-draw" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M-10 110 C 120 40, 240 150, 380 80 S 640 20, 780 90 S 920 60, 980 40" style={{ ['--ws-len' as string]: 1100, ['--ws-delay' as string]: '0ms' }} />
          <path d="M-10 70 C 150 130, 300 10, 460 70 S 760 130, 980 70" style={{ ['--ws-len' as string]: 1100, ['--ws-delay' as string]: '150ms' }} />
          <line x1="0" y1="24" x2="960" y2="24" style={{ ['--ws-len' as string]: 960, ['--ws-delay' as string]: '300ms' }} />
          <line x1="0" y1="118" x2="960" y2="118" style={{ ['--ws-len' as string]: 960, ['--ws-delay' as string]: '380ms' }} />
          <circle cx="860" cy="70" r="46" style={{ ['--ws-len' as string]: 290, ['--ws-delay' as string]: '500ms' }} />
        </g>
      </svg>

      <div className="relative flex items-center gap-6 px-6 py-6">
        <div className="ws-float hidden shrink-0 sm:block" aria-hidden>
          <svg viewBox="0 0 120 96" className="h-24 w-[120px]" fill="none">
            <rect x="14" y="6" width="92" height="84" rx="10" className="fill-background stroke-border" strokeWidth="1.5" />
            <rect x="26" y="24" width="48" height="6" rx="3" className="fill-primary/70" />
            <rect x="26" y="40" width="68" height="10" rx="4" className="fill-surface-subtle stroke-border" strokeWidth="1" />
            <rect x="26" y="58" width="68" height="10" rx="4" className="fill-surface-subtle stroke-border" strokeWidth="1" />
            <rect x="26" y="76" width="30" height="8" rx="4" className="fill-primary" />
            <circle cx="92" cy="22" r="9" className="fill-primary/15" />
            <path d="M88 22 l3 3 l5 -6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-primary">Form workspace</p>
          <p className="mt-1 max-w-[520px] text-[14px] leading-6 text-muted-foreground">
            Build forms with drag-and-drop fields, share them as links, and collect responses in one place.
          </p>
        </div>
      </div>
    </div>
  );
}
