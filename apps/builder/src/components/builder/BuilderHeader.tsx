import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  MoreHorizontal,
  Redo2,
  Undo2,
  LayoutTemplate,
  Palette,
  Star,
  Clock,
  PanelLeft,
} from 'lucide-react';
import { useFormStore, useTemporalStore } from '@/store/useFormStore';
import { TemplateModal } from '@/components/builder/TemplateModal';
import { ThemeSettings } from '@/components/builder/ThemeSettings';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Tooltip, modKey } from '@/components/ui/tooltip';

export function BuilderHeader() {
  const form = useFormStore((s) => s.form);
  const mode = useFormStore((s) => s.mode);
  const setMode = useFormStore((s) => s.setMode);
  const sidebarOpen = useFormStore((s) => s.sidebarOpen);
  const setSidebarOpen = useFormStore((s) => s.setSidebarOpen);
  const undo = useTemporalStore((s) => s.undo);
  const redo = useTemporalStore((s) => s.redo);
  const past = useTemporalStore((s) => s.pastStates);
  const future = useTemporalStore((s) => s.futureStates);
  const [templates, setTemplates] = useState(false);
  const [theme, setTheme] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (typing) return;
        e.preventDefault();
        undo();
      }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <>
      <header className="flex h-[45px] shrink-0 items-center gap-0.5 px-3">
        {!sidebarOpen && (
          <Ghost onClick={() => setSidebarOpen(true)} label="Open sidebar">
            <PanelLeft className="size-4" />
          </Ghost>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[14px] text-[var(--notion-text-muted)]">
          <span className="truncate rounded-[4px] px-1.5 py-0.5 hover:bg-[var(--notion-hover)]">Forms</span>
          <ChevronRight className="size-3.5 shrink-0 text-[var(--notion-text-faint)]" />
          <span className="flex min-w-0 items-center gap-1 truncate rounded-[4px] px-1.5 py-0.5 text-[var(--notion-text)] hover:bg-[var(--notion-hover)]">
            <span className="truncate">{form.title || 'Form title'}</span>
          </span>
        </div>

        <div className="flex items-center">
          {(['edit', 'preview'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-[6px] px-2 py-1 text-[14px] capitalize',
                mode === m ? 'bg-[var(--notion-hover)] text-[var(--notion-text)]' : 'text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]',
              )}
            >
              {m === 'edit' ? 'Edit' : 'Preview'}
            </button>
          ))}
        </div>

        <Ghost disabled={past.length === 0} onClick={() => undo()} label="Undo" shortcut={`${modKey()}+Z`}>
          <Undo2 className="size-4" />
        </Ghost>
        <Ghost disabled={future.length === 0} onClick={() => redo()} label="Redo" shortcut={`${modKey()}+Shift+Z`}>
          <Redo2 className="size-4" />
        </Ghost>
        <Ghost onClick={() => setTemplates(true)} label="Templates">
          <LayoutTemplate className="size-4" />
        </Ghost>
        <Ghost onClick={() => setTheme(true)} label="Customize form">
          <Palette className="size-4" />
        </Ghost>
        <Ghost onClick={() => toast.message('Updated just now')} label="Last edited just now">
          <Clock className="size-4" />
        </Ghost>
        <Tooltip content="Copy share link">
          <button
            type="button"
            className="rounded-[6px] px-2 py-1 text-[14px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]"
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href);
              toast.success('Share link copied');
            }}
          >
            Share
          </button>
        </Tooltip>
        <Ghost label="Add to favorites">
          <Star className="size-4" />
        </Ghost>
        <Ghost label="More actions">
          <MoreHorizontal className="size-4" />
        </Ghost>
      </header>
      <TemplateModal open={templates} onOpenChange={setTemplates} />
      <ThemeSettings open={theme} onOpenChange={setTheme} />
    </>
  );
}

function Ghost({
  children,
  onClick,
  label,
  shortcut,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex size-[28px] items-center justify-center rounded-[6px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)] disabled:opacity-30"
      >
        {children}
      </button>
    </Tooltip>
  );
}
