import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'right';

export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children,
  delay = 350,
  className,
}: {
  content: string;
  shortcut?: string;
  side?: Side;
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timer = useRef<number>(0);

  function show() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (side === 'right') setPos({ x: r.right, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top : r.bottom });
      setOpen(true);
    }, delay);
  }

  function hide() {
    window.clearTimeout(timer.current);
    setOpen(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      ref={wrapRef}
      className={cn('inline-flex max-w-full', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className={cn(
                'pointer-events-none fixed z-[100] flex items-center gap-1.5 whitespace-nowrap rounded-[6px] bg-[#1d1c19] px-2 py-[5px] text-[12px] font-medium text-white shadow-[0_4px_12px_rgba(0,0,0,0.18)]',
                side === 'right' && 'translate-x-2 -translate-y-1/2',
                side === 'top' && '-translate-x-1/2 -translate-y-[calc(100%+6px)]',
                side === 'bottom' && '-translate-x-1/2 translate-y-[6px]',
              )}
              style={{ left: pos.x, top: pos.y }}
            >
              {content}
              {shortcut ? (
                <kbd className="rounded-[4px] bg-white/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-white/80">
                  {shortcut}
                </kbd>
              ) : null}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

export function modKey() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
}
