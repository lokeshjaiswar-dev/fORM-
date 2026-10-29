import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SelectOption = { value: string; label: string };

export function NiceSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  className,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }, [open]);

  useEffect(() => {
    function onDoc(e: PointerEvent) {
      const t = e.target as Node;
      if (btn.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white text-left text-zinc-900 outline-none hover:border-zinc-300 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 disabled:bg-zinc-50',
          size === 'sm' ? 'h-8 px-2 text-[13px]' : 'h-10 px-3 text-[15px]',
        )}
      >
        <span className={cn('truncate', !selected && 'text-zinc-400')}>{selected?.label || placeholder}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-zinc-400 transition', open && 'rotate-180')} />
      </button>
      {open
        ? createPortal(
            <ul
              ref={menu}
              data-nice-select=""
              className="fixed z-[80] max-h-56 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              {options.map((o) => {
                const on = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-zinc-900 hover:bg-zinc-50',
                        on && 'bg-zinc-50 font-medium',
                      )}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">{o.label}</span>
                      {on ? <Check className="size-3.5 shrink-0" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
