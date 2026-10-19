import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState, type Editor } from '@tiptap/react';
import { Bold, Highlighter, Italic, Link, Type, Underline } from 'lucide-react';
import { toast } from 'sonner';
import { isSafeHref, type ColorValue } from '@form/schema';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { themeVars } from '@/lib/blockStyle';
import { useDoc } from '@/state/documentStore';
import { colorCss } from '@/components/editor/extensions';

interface Swatch {
  label: string;
  value: ColorValue | null;
}

const hex = (label: string, value: string): Swatch => ({ label, value: value as ColorValue });

/** Theme tokens first (they follow the theme), then a fixed palette. Nothing else can be stored. */
const TEXT_SWATCHES: Swatch[] = [
  { label: 'Default', value: null },
  { label: 'Accent', value: { token: 'accent' } },
  { label: 'Muted', value: { token: 'muted' } },
  { label: 'Error', value: { token: 'error' } },
  { label: 'Success', value: { token: 'success' } },
  hex('Red', '#eb5757'),
  hex('Orange', '#d9730d'),
  hex('Yellow', '#dfab01'),
  hex('Green', '#448361'),
  hex('Blue', '#337ea9'),
  hex('Purple', '#9065b0'),
  hex('Pink', '#c14c8a'),
];

const HIGHLIGHT_SWATCHES: Swatch[] = [
  { label: 'None', value: null },
  hex('Yellow', '#fdecc8'),
  hex('Green', '#dbeddb'),
  hex('Blue', '#d3e5ef'),
  hex('Purple', '#e8deee'),
  hex('Orange', '#fadec9'),
  hex('Red', '#ffe2dd'),
];

/** Floating toolbar over a non-empty selection: bold, italic, underline, palette colours and links. */
const MARKS = ['bold', 'italic', 'underline', 'textColor', 'highlight', 'link'] as const;

export function FormatMenu({ editor }: { editor: Editor }) {
  const settings = useDoc((d) => d.settings);
  const [colorOpen, setColorOpen] = useState<'textColor' | 'highlight' | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from, to, empty } = e.state.selection;
      const active = Object.fromEntries(MARKS.map((m) => [m, e.isActive(m)])) as Record<(typeof MARKS)[number], boolean>;
      return { open: e.isFocused && !empty, from, to, active };
    },
  });
  if (!state.open) return null;

  let start: { left: number; top: number };
  let end: { left: number; top: number };
  try {
    start = editor.view.coordsAtPos(state.from);
    end = editor.view.coordsAtPos(state.to);
  } catch {
    return null;
  }
  const left = start.top === end.top ? (start.left + end.left) / 2 : start.left;

  function setColor(type: 'textColor' | 'highlight', value: ColorValue | null) {
    const chain = editor.chain().focus();
    (value ? chain.setMark(type, { color: value }) : chain.unsetMark(type)).run();
    setColorOpen(null);
  }

  function addLink() {
    const current = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', current ?? 'https://')?.trim();
    if (url === undefined) return;
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
      return;
    }
    if (!isSafeHref(url)) {
      toast.error('Links must be full https:, http:, mailto: or tel: addresses');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setMark('link', { href: url }).run();
  }

  return createPortal(
    <div
      role="toolbar"
      aria-label="Text formatting"
      className="fixed z-50 flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-0.5 rounded-xl border border-zinc-200 bg-white px-1 py-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]"
      style={{ ...themeVars(settings), left, top: Math.min(start.top, end.top) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Tool onClick={() => editor.chain().focus().toggleMark('bold').run()} label="Bold" shortcut="⌘B" active={state.active.bold}>
        <Bold className="size-3.5" />
      </Tool>
      <Tool onClick={() => editor.chain().focus().toggleMark('italic').run()} label="Italic" shortcut="⌘I" active={state.active.italic}>
        <Italic className="size-3.5" />
      </Tool>
      <Tool onClick={() => editor.chain().focus().toggleMark('underline').run()} label="Underline" shortcut="⌘U" active={state.active.underline}>
        <Underline className="size-3.5" />
      </Tool>
      <span className="mx-0.5 h-4 w-px bg-zinc-200" />
      {(['textColor', 'highlight'] as const).map((type) => (
        <div key={type} className="relative">
          <Tool onClick={() => setColorOpen((v) => (v === type ? null : type))} label={type === 'textColor' ? 'Text color' : 'Highlight'} active={state.active[type]}>
            {type === 'textColor' ? <Type className="size-3.5" /> : <Highlighter className="size-3.5" />}
          </Tool>
          {colorOpen === type ? (
            <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 gap-1 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-md">
              {(type === 'textColor' ? TEXT_SWATCHES : HIGHLIGHT_SWATCHES).map((swatch) => (
                <Tooltip key={swatch.label} content={swatch.label} side="bottom" delay={200}>
                  <button
                    type="button"
                    aria-label={swatch.label}
                    className="size-5 rounded-full border border-zinc-200"
                    style={{ background: swatch.value ? colorCss(swatch.value) : '#fff' }}
                    onClick={() => setColor(type, swatch.value)}
                  />
                </Tooltip>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <Tool onClick={addLink} label="Add link" active={state.active.link}>
        <Link className="size-3.5" />
      </Tool>
    </div>,
    document.body,
  );
}

function Tool({ children, onClick, label, shortcut, active }: { children: ReactNode; onClick: () => void; label: string; shortcut?: string; active?: boolean }) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="top" delay={200}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cn('flex size-7 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100', active && 'bg-zinc-100')}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
