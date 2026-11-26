import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LayoutTemplate, MoreHorizontal, PanelLeft, Redo2, Share2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { redo, undo, useCanRedo, useCanUndo } from '@/state/history';
import { useUiStore, type SaveState } from '@/state/uiStore';
import { TemplateDialog } from '@/components/templates/TemplateDialog';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@dmacq/ui';
import { Tooltip, modKey } from '@/components/Tooltip';
import { flushAutosave } from '@/persistence/autosave';
import { PublishIssuesDialog } from '@/components/builder/PublishIssuesDialog';
import { FormName } from '@/components/builder/header/FormName';
import { ViewTabs } from '@/components/builder/header/ViewTabs';
import { ShareDialog } from '@/components/builder/header/ShareDialog';
import { usePublish } from '@/components/builder/header/usePublish';

const M = defineMessages('builder', {
  'header.saved_local': 'Saved on this device',
  'header.conflict': 'Changed elsewhere',
  'header.settings': 'Settings',
});

/** Templates and More (Share) are hidden from the bar for now; set to true to bring them back. */
const SHOW_EXTRA_ACTIONS = false;

/** Dark top bar across the whole builder (Figma DMacq Design System 5356:183289): name, view tabs, draft and publish. */
export function BuilderHeader() {
  const { id = '' } = useParams();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const save = useUiStore((s) => s.save);
  const publishing = usePublish(id);
  const [templates, setTemplates] = useState(false);

  return (
    <>
      <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-sidebar-border bg-sidebar px-2 text-sidebar-foreground">
        <div className="flex min-w-0 items-center gap-2">
          {!sidebarOpen && (
            <IconAction onClick={() => setSidebarOpen(true)} label="Open sidebar">
              <PanelLeft className="size-4" />
            </IconAction>
          )}
          <Tooltip content="Back to forms">
            <Button asChild variant="ghost" color="whiteOnPrimary" size="icon" className="shrink-0 text-sidebar-muted">
              <Link to="/forms" aria-label="Back to forms">
                <X className="size-5" />
              </Link>
            </Button>
          </Tooltip>
          <FormName />
          <SaveStatus save={save} />
        </div>

        <ViewTabs />

        <div className="flex min-w-0 items-center justify-end gap-2">
          <HistoryAndTools onTemplates={() => setTemplates(true)} onShare={publishing.link ? () => publishing.setShareOpen(true) : null} />
          {id ? (
            <Button variant="ghost" color="whiteOnPrimary" asChild>
              {/* The form's emails, webhooks and email log: what happens after a response is stored. */}
              <Link to={`/forms/${encodeURIComponent(id)}/settings`}>{t(M['header.settings'])}</Link>
            </Button>
          ) : null}
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-sidebar-border" />
          <SaveDraftButton />
          <Button type="button" disabled={publishing.busy || !id} onClick={() => void publishing.publish()}>
            {publishing.busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </header>
      <TemplateDialog open={templates} onOpenChange={setTemplates} />
      <PublishIssuesDialog
        issues={publishing.listed?.issues ?? null}
        issueCount={publishing.listed?.count ?? 0}
        blocked={publishing.listed?.issues.some((i) => i.severity === 'error') ?? false}
        busy={publishing.busy}
        onClose={publishing.closeListed}
        onPublishAnyway={() => void publishing.publish(true)}
        onGoToField={publishing.goToField}
      />
      <ShareDialog state={publishing} />
    </>
  );
}

/** Undo and Redo as icons; Templates and More (Share) follow them when SHOW_EXTRA_ACTIONS is on. */
function HistoryAndTools({ onTemplates, onShare }: { onTemplates: () => void; onShare: (() => void) | null }) {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconAction disabled={!canUndo} onClick={undo} label="Undo" shortcut={`${modKey()}+Z`}>
        <Undo2 className="size-4" />
      </IconAction>
      <IconAction disabled={!canRedo} onClick={redo} label="Redo" shortcut={`${modKey()}+Shift+Z`}>
        <Redo2 className="size-4" />
      </IconAction>
      {SHOW_EXTRA_ACTIONS ? (
        <>
          <IconAction onClick={onTemplates} label="Templates">
            <LayoutTemplate className="size-4" />
          </IconAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" color="whiteOnPrimary" size="icon" aria-label="More actions" className="text-sidebar-muted">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onShare ? (
                <DropdownMenuItem onSelect={onShare}>
                  <Share2 />
                  Share
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  );
}

/** Writes the pending change now instead of waiting for autosave, and says whether it was written. */
function SaveDraftButton() {
  const [busy, setBusy] = useState(false);
  async function saveDraft() {
    setBusy(true);
    try {
      await flushAutosave();
      const after = useUiStore.getState().save;
      if (after.state === 'error') toast.error(after.message || 'The draft could not be saved.');
      else toast.success('Draft saved');
    } catch {
      toast.error('The draft could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button type="button" variant="ghost" color="whiteOnPrimary" disabled={busy} onClick={() => void saveDraft()}>
      Save As Draft
    </Button>
  );
}

/* Hidden from view for now but still announced to screen readers; drop `sr-only` to show it again. */
function SaveStatus({ save }: { save: SaveState }) {
  return (
    <span
      role="status"
      title={save.state === 'error' ? save.message : undefined}
      className="sr-only flex shrink-0 items-center gap-1.5 text-[12px] text-sidebar-muted"
    >
      {save.state === 'idle' ? null : <SaveDot state={save.state} />}
      {saveLabel(save)}
    </span>
  );
}

/** Animated status dot: a soft pulse while saving, solid when saved, red when the save failed. */
function SaveDot({ state }: { state: SaveState['state'] }) {
  const color = state === 'error' ? 'bg-destructive' : state === 'saved' ? 'bg-positive' : 'bg-sidebar-muted';
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {state === 'saving' ? <span className={`ws-live absolute inline-flex size-full rounded-full ${color}`} /> : null}
      <span className={`relative inline-flex size-2 rounded-full transition-colors duration-300 ${color}`} />
    </span>
  );
}

function saveLabel(save: SaveState): string {
  switch (save.state) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'local':
      return t(M['header.saved_local']);
    case 'conflict':
      return t(M['header.conflict']);
    case 'error':
      return 'Not saved';
    default:
      return '';
  }
}

function IconAction({
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
      <Button type="button" variant="ghost" color="whiteOnPrimary" size="icon" aria-label={label} disabled={disabled} onClick={onClick} className="text-sidebar-muted">
        {children}
      </Button>
    </Tooltip>
  );
}
