import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Redo2, Undo2, LayoutTemplate, PanelLeft } from 'lucide-react';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import type { BlockId } from '@form/schema';
import { t } from '@/i18n';
import { useDoc, currentDoc } from '@/state/documentStore';
import { redo, undo, useCanRedo, useCanUndo } from '@/state/history';
import { useUiStore, type SaveState } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { TemplateDialog } from '@/components/templates/TemplateDialog';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { Tooltip, modKey } from '@/components/Tooltip';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { flushAutosave } from '@/persistence/autosave';
import { CopyLink } from '@/components/CopyLink';
import { PublishIssuesDialog } from '@/components/builder/PublishIssuesDialog';
import { rememberAfterSignIn } from '@/auth/returnTo';
import {
  DraftNotSaved,
  OrgRequired,
  PublishBlocked,
  PublishConflict,
  SignInRequired,
  checkPublishable,
  fillUrl,
  publishLive,
  rememberedSlug,
  type PublishIssueView,
} from '@/persistence/publishApi';

const M = defineMessages('builder', {
  'header.saved_local': 'Saved on this device',
  'header.conflict': 'Changed elsewhere',
  'header.plan_mismatch': 'This browser and the server disagree about how the form compiles. Reload the page, then publish again.',
  'header.conflict_toast': 'This form changed somewhere else. Choose which version to keep, then publish again.',
  'header.settings': 'Settings',
});

/** What the publish dialog lists: the server's issues, and whether any of them blocks. */
interface PublishIssues {
  issues: PublishIssueView[];
  count: number;
}

export function BuilderHeader() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const title = useDoc((d) => d.title);
  const [mode, setMode] = useBuilderMode();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const save = useUiStore((s) => s.save);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [templates, setTemplates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [link, setLink] = useState<string | null>(() => {
    const slug = rememberedSlug(id);
    return slug ? fillUrl(slug) : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [listed, setListed] = useState<PublishIssues | null>(null);

  useEffect(() => {
    const slug = rememberedSlug(id);
    setLink(slug ? fillUrl(slug) : null);
  }, [id]);

  /** Freezes the saved draft as the live version and shows the share link. */
  async function publish() {
    const live = await publishLive(id, currentDoc());
    setListed(null);
    setLink(fillUrl(live.slug));
    setShareOpen(true);
  }

  /**
   * Publish: the draft is saved, the server checks it (`/validate`), and only a draft with no error goes on to
   * publish. Warnings are listed first and published on confirmation (`confirmed`).
   */
  async function onPublish(confirmed = false) {
    setBusy(true);
    setError(null);
    try {
      await flushAutosave();
      if (!confirmed) {
        const check = await checkPublishable(id);
        const blocking = check.issues.some((i) => i.severity === 'error');
        if (blocking || check.issues.length) {
          setListed({ issues: check.issues, count: check.issueCount });
          return;
        }
      }
      await publish();
    } catch (err) {
      // Not signed in (or the session ended): the draft is already saved in this browser, so sign in and come back.
      if (err instanceof SignInRequired || (err instanceof ApiProblem && err.status === 401)) {
        rememberAfterSignIn(pathname);
        toast('Sign in to publish. Your form is saved in this browser.');
        navigate('/auth/sign-in');
        return;
      }
      if (err instanceof OrgRequired) {
        rememberAfterSignIn(pathname);
        toast('Create an organisation first: forms are published into one.');
        navigate('/orgs/new');
        return;
      }
      if (err instanceof PublishBlocked && err.code === 'PUBLISH_BLOCKED') {
        setListed({ issues: err.issues, count: err.issueCount });
        return;
      }
      // The merge dialog is open already; it is what the author needs to answer.
      if (err instanceof PublishConflict) {
        toast(t(M['header.conflict_toast']));
        return;
      }
      if (err instanceof DraftNotSaved && err.conflict) return;
      setShareOpen(true);
      if (err instanceof PublishBlocked) setError(t(M['header.plan_mismatch']));
      else if (err instanceof ApiUnreachable) setError('The API is not running, so this form cannot be shared yet.');
      else if (err instanceof ApiProblem) {
        setError(
          err.code === 'SERVICE_UNAVAILABLE' || err.code === 'INTERNAL'
            ? 'This form could not be published right now. Try Publish again in a moment.'
            : err.message || 'This form could not be published.',
        );
      }
      else setError(err instanceof Error ? err.message : 'This form could not be published.');
    } finally {
      setBusy(false);
    }
  }

  /** Opens the inspector of the block an issue is about (in Edit, where the inspector is). */
  function goToField(blockId: BlockId) {
    if (!currentDoc().blocks[blockId]) return;
    setListed(null);
    if (mode === 'preview') setMode('edit');
    useUiStore.getState().openInspector(blockId);
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
        {id ? (
          <Button variant="ghost" size="sm" asChild>
            {/* The form's emails, webhooks and email log: what happens after a response is stored. */}
            <Link to={`/forms/${encodeURIComponent(id)}/settings`}>{t(M['header.settings'])}</Link>
          </Button>
        ) : null}
        <Button type="button" size="sm" className="ml-1" disabled={busy || !id} onClick={() => void onPublish()}>
          {busy ? 'Publishing…' : 'Publish'}
        </Button>
        {link ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setShareOpen(true)}>
            Share
          </Button>
        ) : null}
      </header>
      <TemplateDialog open={templates} onOpenChange={setTemplates} />
      <PublishIssuesDialog
        issues={listed?.issues ?? null}
        issueCount={listed?.count ?? 0}
        blocked={listed?.issues.some((i) => i.severity === 'error') ?? false}
        busy={busy}
        onClose={() => setListed(null)}
        onPublishAnyway={() => void onPublish(true)}
        onGoToField={goToField}
      />
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{link ? 'Share form' : 'Publish form'}</DialogTitle>
            <DialogDescription>
              {link
                ? 'Anyone with this link can fill the form on a phone or another computer. They do not need to sign in.'
                : 'Publish this form to get a link you can open on any device.'}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-[14px] text-destructive">
              {error}
            </p>
          ) : null}
          {link ? (
            <CopyLink
              link={link}
              label="Share link"
              onCopied={() => {
                setError(null);
                toast('Link copied');
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
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
