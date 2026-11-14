import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Redo2, Undo2, LayoutTemplate, PanelLeft } from 'lucide-react';
import { toast } from 'sonner';
import { runtimeEdition } from '@form/config';
import type { IsoInstant } from '@form/schema';
import { useDoc, currentDoc } from '@/state/documentStore';
import { redo, undo, useCanRedo, useCanUndo } from '@/state/history';
import { useUiStore, type SaveState } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { TemplateDialog } from '@/components/templates/TemplateDialog';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { Tooltip, modKey } from '@/components/Tooltip';
import { useEdition } from '@/edition/edition';
import { previewVersion } from '@/lib/preview';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { flushAutosave } from '@/persistence/autosave';
import { CopyLink } from '@/components/CopyLink';
import { rememberAfterSignIn } from '@/auth/returnTo';
import { OrgRequired, SignInRequired, fillUrl, publishLive, rememberedSlug } from '@/persistence/publishApi';

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
  const edition = useEdition();

  useEffect(() => {
    const slug = rememberedSlug(id);
    setLink(slug ? fillUrl(slug) : null);
  }, [id]);

  async function onPublish() {
    setBusy(true);
    setError(null);
    try {
      await flushAutosave();
      const doc = currentDoc();
      const built = previewVersion(doc, { state: 'open' }, new Date().toISOString() as IsoInstant, runtimeEdition(edition));
      if (!built.ok) {
        const first = built.issues.find((i) => i.severity === 'error') ?? built.issues[0];
        setError(first?.message ?? 'This form cannot be published yet.');
        setShareOpen(true);
        return;
      }
      const live = await publishLive(id, doc, doc.title);
      const url = fillUrl(live.slug);
      setLink(url);
      setShareOpen(true);
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
      setShareOpen(true);
      if (err instanceof ApiUnreachable) setError('The API is not running, so this form cannot be shared yet.');
      else if (err instanceof ApiProblem) {
        setError(
          err.code === 'SERVICE_UNAVAILABLE' || err.code === 'INTERNAL'
            ? 'The database did not answer in time. Try Publish again.'
            : err.message || 'This form could not be published.',
        );
      }
      else setError(err instanceof Error ? err.message : 'This form could not be published.');
    } finally {
      setBusy(false);
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
