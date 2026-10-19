import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  MoreHorizontal,
  Redo2,
  Undo2,
  LayoutTemplate,
  Palette,
  Star,
  PanelLeft,
} from 'lucide-react';
import { useDoc } from '@/state/documentStore';
import { redo, undo, useCanRedo, useCanUndo } from '@/state/history';
import { useUiStore, type SaveState } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { TemplateModal } from '@/components/builder/TemplateModal';
import { ThemeSettings } from '@/components/builder/ThemeSettings';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Tooltip, modKey } from '@/components/ui/tooltip';

export function BuilderHeader() {
  const title = useDoc((d) => d.title);
  const [mode, setMode] = useBuilderMode();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const save = useUiStore((s) => s.save);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [templates, setTemplates] = useState(false);
  const [theme, setTheme] = useState(false);

  return (
    <>
      <header className="flex h-[45px] shrink-0 items-center gap-0.5 px-3">
        {!sidebarOpen && (
          <Ghost onClick={() => setSidebarOpen(true)} label="Open sidebar">
            <PanelLeft className="size-4" />
          </Ghost>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[14px] text-[var(--notion-text-muted)]">
          <Link to="/forms" className="truncate rounded-[4px] px-1.5 py-0.5 hover:bg-[var(--notion-hover)]">
            Forms
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-[var(--notion-text-faint)]" />
          <span className="flex min-w-0 items-center gap-1 truncate rounded-[4px] px-1.5 py-0.5 text-[var(--notion-text)] hover:bg-[var(--notion-hover)]">
            <span className="truncate">{title || 'Form title'}</span>
          </span>
          <span role="status" title={save.state === 'error' ? save.message : undefined} className="ml-1 shrink-0 text-[13px] text-[var(--notion-text-faint)]">
            {saveLabel(save)}
          </span>
        </div>

        <div className="flex items-center">
          {(['edit', 'preview'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
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

        <Ghost disabled={!canUndo} onClick={undo} label="Undo" shortcut={`${modKey()}+Z`}>
          <Undo2 className="size-4" />
        </Ghost>
        <Ghost disabled={!canRedo} onClick={redo} label="Redo" shortcut={`${modKey()}+Shift+Z`}>
          <Redo2 className="size-4" />
        </Ghost>
        <Ghost onClick={() => setTemplates(true)} label="Templates">
          <LayoutTemplate className="size-4" />
        </Ghost>
        <Ghost onClick={() => setTheme(true)} label="Customize form">
          <Palette className="size-4" />
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

function saveLabel(save: SaveState): string {
  switch (save.state) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Not saved';
    default:
      return '';
  }
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
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex size-[28px] items-center justify-center rounded-[6px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)] disabled:opacity-30"
      >
        {children}
      </button>
    </Tooltip>
  );
}
