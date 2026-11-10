import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ChevronRight,
  MoreHorizontal,
  Redo2,
  Undo2,
  LayoutTemplate,
  Star,
  PanelLeft,
} from 'lucide-react';
import { useDoc } from '@/state/documentStore';
import { redo, undo, useCanRedo, useCanUndo } from '@/state/history';
import { useUiStore, type SaveState } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { TemplateDialog } from '@/components/templates/TemplateDialog';
import { AccountMenu } from '@/auth/AccountMenu';
import { EditionBadge } from '@/edition/EditionBadge';
import { toast } from 'sonner';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { Button } from '@dmacq/ui';
import { Tooltip, modKey } from '@/components/Tooltip';
import { whenSaved } from '@/persistence/autosave';
import { fillUrl, getLiveForm, publishForm } from '@/persistence/publishApi';

export function BuilderHeader() {
  const { id = '' } = useParams();
  const title = useDoc((d) => d.title);
  const [mode, setMode] = useBuilderMode();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const save = useUiStore((s) => s.save);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [templates, setTemplates] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function publish() {
    setPublishing(true);
    try {
      await whenSaved();
      const live = await publishForm(id);
      await navigator.clipboard.writeText(fillUrl(live.slug));
      toast.success('Published. Share link copied');
    } catch (err) {
      if (err instanceof ApiUnreachable) toast.error('Sign in and keep the API running to publish.');
      else if (err instanceof ApiProblem) toast.error(err.message || 'This form cannot be published yet.');
      else toast.error('This form cannot be published yet.');
    } finally {
      setPublishing(false);
    }
  }

  async function share() {
    try {
      const live = await getLiveForm(id);
      await navigator.clipboard.writeText(fillUrl(live.slug));
      toast.success('Share link copied');
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 404) toast.error('Publish the form first to get a share link.');
      else if (err instanceof ApiUnreachable) toast.error('Sign in to copy the live share link.');
      else toast.error('The share link could not be copied.');
    }
  }

  return (
    <>
      <header className="flex h-[45px] shrink-0 items-center gap-0.5 border-b border-border bg-background px-3">
        {!sidebarOpen && (
          <Ghost onClick={() => setSidebarOpen(true)} label="Open sidebar">
            <PanelLeft className="size-4" />
          </Ghost>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[14px] text-muted-foreground">
          <Link to="/forms" className="truncate rounded-[4px] px-1.5 py-0.5 hover:bg-state-hover">
            Forms
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-text-subtle" />
          <span className="flex min-w-0 items-center gap-1 truncate rounded-[4px] px-1.5 py-0.5 text-foreground hover:bg-state-hover">
            <span className="truncate">{title || 'Form title'}</span>
          </span>
          <span role="status" title={save.state === 'error' ? save.message : undefined} className="ml-1 shrink-0 text-[13px] text-text-subtle">
            {saveLabel(save)}
          </span>
        </div>

        <EditionBadge className="mr-1" />

        <div className="flex items-center gap-0.5">
          {(['edit', 'preview'] as const).map((m) => (
            <Button key={m} type="button" variant="ghost" size="sm" pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'edit' ? 'Edit' : 'Preview'}
            </Button>
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
        <Button type="button" variant="ghost" size="sm" disabled={publishing} onClick={() => void publish()}>
          {publishing ? 'Publishing…' : 'Publish'}
        </Button>
        <Tooltip content="Copy public fill link">
          <Button type="button" variant="ghost" size="sm" onClick={() => void share()}>
            Share
          </Button>
        </Tooltip>
        <Ghost label="Add to favorites">
          <Star className="size-4" />
        </Ghost>
        <Ghost label="More actions">
          <MoreHorizontal className="size-4" />
        </Ghost>
        <AccountMenu />
      </header>
      <TemplateDialog open={templates} onOpenChange={setTemplates} />
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
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </Button>
    </Tooltip>
  );
}
