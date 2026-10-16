import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Italic, Underline, Highlighter, Link, Type } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

const COLORS = ['#111111', '#eb5757', '#d9730d', '#dfab01', '#448361', '#337ea9', '#9065b0', '#c14c8a'];
const HILITES = ['transparent', '#fdecc8', '#dbeddb', '#d3e5ef', '#e8deee', '#fadec9', '#ffe2dd'];

export function isEmptyHtml(html: string) {
  return !html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

export function RichText({
  value,
  onChange,
  placeholder,
  className,
  style,
  onEnter,
  autoFocus,
  fill = true,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  onEnter?: () => void;
  autoFocus?: boolean;
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [colorOpen, setColorOpen] = useState<'text' | 'bg' | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML !== value) el.innerHTML = value || '';
  }, [value]);

  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      const sel = window.getSelection();
      const el = ref.current;
      if (sel && el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [autoFocus]);

  function placeMenu() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current?.contains(sel.anchorNode)) {
      setMenu(null);
      setColorOpen(null);
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) {
      setMenu(null);
      return;
    }
    setMenu({ x: r.left + r.width / 2, y: r.top });
  }

  function cmd(command: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML ?? '');
    placeMenu();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onEnter?.();
    }
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  return (
    <>
      <div className={cn('relative flex min-h-8 min-w-0 items-center', fill ? 'flex-1' : 'max-w-[calc(100%-1.25rem)]')}>
        {isEmptyHtml(value) ? (
          <div className="pointer-events-none absolute inset-0 flex items-center whitespace-nowrap text-[#c5c4c1]" style={style}>
            {placeholder}
          </div>
        ) : null}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          className={cn('min-h-[1em] outline-none', className)}
          style={style}
          onInput={() => onChange(ref.current?.innerHTML ?? '')}
          onKeyUp={placeMenu}
          onMouseUp={placeMenu}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            window.setTimeout(() => {
              if (!ref.current?.contains(document.activeElement)) {
                setMenu(null);
                setColorOpen(null);
              }
            }, 150);
          }}
        />
      </div>
      {menu
        ? createPortal(
            <div
              className="fixed z-50 flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-0.5 rounded-xl border border-zinc-200 bg-white px-1 py-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Tool onClick={() => cmd('bold')} label="Bold" shortcut="⌘B">
                <Bold className="size-3.5" />
              </Tool>
              <Tool onClick={() => cmd('italic')} label="Italic" shortcut="⌘I">
                <Italic className="size-3.5" />
              </Tool>
              <Tool onClick={() => cmd('underline')} label="Underline" shortcut="⌘U">
                <Underline className="size-3.5" />
              </Tool>
              <span className="mx-0.5 h-4 w-px bg-zinc-200" />
              <div className="relative">
                <Tool onClick={() => setColorOpen((v) => (v === 'text' ? null : 'text'))} label="Text color">
                  <Type className="size-3.5" />
                </Tool>
                {colorOpen === 'text' ? (
                  <Swatches colors={COLORS} onPick={(c) => cmd('foreColor', c)} />
                ) : null}
              </div>
              <div className="relative">
                <Tool onClick={() => setColorOpen((v) => (v === 'bg' ? null : 'bg'))} label="Highlight">
                  <Highlighter className="size-3.5" />
                </Tool>
                {colorOpen === 'bg' ? (
                  <Swatches
                    colors={HILITES}
                    onPick={(c) => cmd(c === 'transparent' ? 'removeFormat' : 'hiliteColor', c)}
                  />
                ) : null}
              </div>
              <Tool
                onClick={() => {
                  const url = window.prompt('Link URL', 'https://');
                  if (url) cmd('createLink', url);
                }}
                label="Add link"
              >
                <Link className="size-3.5" />
              </Tool>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Tool({
  children,
  onClick,
  label,
  shortcut,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  shortcut?: string;
}) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="top" delay={200}>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100"
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Swatches({ colors, onPick }: { colors: string[]; onPick: (c: string) => void }) {
  return (
    <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 gap-1 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-md">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className="size-5 rounded-full border border-zinc-200"
          style={{ background: c === 'transparent' ? '#fff' : c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}
