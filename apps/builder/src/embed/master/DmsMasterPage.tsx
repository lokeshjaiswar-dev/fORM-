import { useMemo, useState, type ReactNode } from 'react';
import { useLeaveGuard } from '@/embed/leaveGuard';
import { PanelLeft, Redo2, Undo2 } from 'lucide-react';
import type { ProfileIssue } from '@form/registry/profiles/dms-v1';
import type { BlockId } from '@form/schema';
import { Alert, AlertDescription, AlertTitle, Button } from '@dmacq/ui';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { BuilderDnd } from '@/components/builder/BuilderDnd';
import { DeleteBlockDialog } from '@/components/builder/DeleteBlockDialog';
import { FieldPicker } from '@/components/builder/FieldPicker';
import { FormCanvas } from '@/components/builder/FormCanvas';
import { SessionBanners } from '@/components/builder/SessionBanners';
import { useBlockClipboard } from '@/components/builder/useBlockClipboard';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Tooltip } from '@/components/Tooltip';
import { DmsApiError, DmsAuthError } from '@/embed/dmsClient';
import { describeDmsError, referenceLine, schemaSyncOf, terminalLoadCodeOf, type TerminalLoadCode } from '@/embed/master/describeDmsError';
import { RemovalDialog } from '@/embed/master/removal/RemovalDialog';
import { RemovalMarks } from '@/embed/master/removal/RemovalMarks';
import { useRemovalConsent } from '@/embed/master/removal/useRemovalConsent';
import { useRemovalMarks } from '@/embed/master/removal/useRemovalMarks';
import { RevealCtx } from '@/embed/master/revealContext';
import { currentLaunch, rememberMasterId, returnTarget, type ResolvedLaunch } from '@/embed/launch';
import { ProfileProvider } from '@/embed/profile';
import { blockText } from '@/lib/definition';
import { RepositoryProvider } from '@/persistence/RepositoryContext';
import { useFormSession } from '@/persistence/useFormSession';
import { currentDoc, useDocumentStore } from '@/state/documentStore';
import { redo, undo, useCanRedo, useCanUndo, useHistoryShortcuts } from '@/state/history';
import { useUiStore } from '@/state/uiStore';
import { DmsCommitRefused, DmsMasterRepository, NotAFormPlusMaster, RemovalCancelled, type CommitResult } from '@/embed/master/DmsMasterRepository';

/** `/embed/dms-master`: fORM- as the DMS master builder (profile `dms-v1`). Outside the fORM- session: DMS is the system of record. */
export function DmsMasterPage({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const resolved = useMemo(() => currentLaunch('dms-master'), []);
  if (!resolved.ok) return <LaunchProblem reason={resolved.reason} />;
  return (
    <ProfileProvider profile="dms-v1">
      <MasterApp launch={resolved.launch} navigate={navigate} />
    </ProfileProvider>
  );
}

const LAUNCH_TEXT = {
  missing: 'Open this page from DMS. It starts with the master you chose and cannot be opened on its own.',
  malformed: 'DMS sent a launch link this page cannot read. Go back to DMS and try again.',
  invalid: 'DMS sent a launch link with missing or unexpected details. Go back to DMS and try again.',
  wrong_mode: 'This launch link is for another DMS screen. Go back to DMS and try again.',
  api_origin_rejected: 'This launch link points at a DMS server this page is not set up to talk to, so nothing was sent to it.',
} as const;

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
      <h1 className="text-[28px] font-bold">{title}</h1>
      <div className="mt-2 space-y-4 text-[15px] text-muted-foreground">{children}</div>
    </main>
  );
}

function LaunchProblem({ reason }: { reason: keyof typeof LAUNCH_TEXT }) {
  return (
    <Message title="This page was not opened from DMS">
      <p>{LAUNCH_TEXT[reason]}</p>
    </Message>
  );
}

function MasterApp({ launch, navigate }: { launch: ResolvedLaunch; navigate: (url: string) => void }) {
  const repo = useMemo(() => new DmsMasterRepository(launch), [launch]);
  return (
    <RepositoryProvider repo={repo}>
      <MasterSession repo={repo} launch={launch} navigate={navigate} />
    </RepositoryProvider>
  );
}

/**
 * "Back to DMS". After a load the page cannot continue from (NOT_FOUND, FORBIDDEN_RIGHT, FP_SCOPE_DENIED, MASTER_NOT_CONVERTED) the link
 * carries `fp_status=error&fp_code=<code>` (DESIGN 3.5), so DMS can say why; otherwise it is the plain return link.
 */
function BackToDms({ launch, status, errorCode }: { launch: ResolvedLaunch; status?: 'cancelled'; errorCode?: TerminalLoadCode | null }) {
  if (!launch.returnUrl) return null;
  const href = errorCode ? returnTarget(launch.returnUrl, 'error', launch.masterId, errorCode) : status ? returnTarget(launch.returnUrl, status) : launch.returnUrl;
  return (
    <p>
      <a className="underline" href={href}>
        Back to DMS
      </a>
    </p>
  );
}

function MasterSession({ repo, launch, navigate }: { repo: DmsMasterRepository; launch: ResolvedLaunch; navigate: (url: string) => void }) {
  const session = useFormSession(repo.formId);
  if (session.status === 'ready') return <MasterBuilder repo={repo} launch={launch} navigate={navigate} />;
  if (session.status === 'loading') return <main className="h-svh bg-background" aria-busy="true" />;
  const why = repo.lastLoadError;
  if (why instanceof DmsAuthError) {
    return (
      <Message title="Sign in to DMS again">
        <p>Your DMS session has ended, so the master could not be opened. Sign in to DMS, then open it again.</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  /* A master that is not a Forms+ master is the same dead end as DMS answering MASTER_NOT_CONVERTED. */
  const code: TerminalLoadCode | null = why instanceof NotAFormPlusMaster ? 'MASTER_NOT_CONVERTED' : terminalLoadCodeOf(why);
  const message = why instanceof DmsApiError ? describeDmsError(why) : session.status === 'missing' ? 'DMS has no such master.' : session.status === 'error' ? session.message : '';
  const reference = referenceLine(why);
  return (
    <Message title={why instanceof NotAFormPlusMaster ? 'This master cannot be edited here' : 'This master cannot be opened'}>
      <p>{message}</p>
      {reference ? <p className="text-[13px]" data-testid="fp-error-reference">{reference}</p> : null}
      <BackToDms launch={launch} errorCode={code} />
    </Message>
  );
}

const EMPTY_ISSUES: ProfileIssue[] = [];

function MasterBuilder({ repo, launch, navigate }: { repo: DmsMasterRepository; launch: ResolvedLaunch; navigate: (url: string) => void }) {
  useHistoryShortcuts();
  useBlockClipboard();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const doc = useDocumentStore((s) => s.doc);
  const [baseline, setBaseline] = useState(doc);
  const [busy, setBusy] = useState(false);
  /* What the guard said, and the doc it said it about: an edit makes the warnings and the "Save anyway" confirmation stale. */
  const [checked, setChecked] = useState<{ doc: typeof doc; issues: ProfileIssue[]; confirmed: string | null } | null>(null);
  const issues = checked && checked.doc === doc ? checked.issues : EMPTY_ISSUES;
  const confirmed = checked && checked.doc === doc ? checked.confirmed : null;
  const [problem, setProblem] = useState<string | null>(null);
  const [problemRef, setProblemRef] = useState<string | null>(null);
  const [problemSaved, setProblemSaved] = useState(false);
  /* Deleting a block DMS stores only marks it; Save asks for consent per marked field (SEC-DESIGN 7.3). */
  const consent = useRemovalConsent();
  const { marks, restore } = useRemovalMarks(repo.current?.fields);
  const hiddenCount = repo.current?.hiddenFieldCount ?? 0;
  const [signedOut, setSignedOut] = useState(false);
  const [saved, setSaved] = useState<CommitResult | null>(null);
  const dirty = doc !== baseline;
  const creating = repo.current === null;

  /* Local edits are the only copy until "Save to DMS" (no draft recovery). */
  const allowLeave = useLeaveGuard(dirty);

  function goTo(blockId: string | undefined) {
    if (blockId && currentDoc().blocks[blockId as BlockId]) useUiStore.getState().openInspector(blockId as BlockId);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setProblemRef(null);
    setProblemSaved(false);
    /* What DMS receives is the doc as it is now; edits made while the request is in flight are not in it. */
    const sent = currentDoc();
    const wasCreating = repo.current === null;
    try {
      const result = await repo.commit(sent, { confirmedWarnings: confirmed, askRemoval: consent.ask });
      if (wasCreating) rememberMasterId('dms-master', result.masterId);
      setBaseline(sent);
      setChecked(null);
      /* Edited meanwhile: stay in the builder (header says "Changes not saved to DMS") instead of leaving with them. */
      if (currentDoc() !== sent) return;
      if (launch.returnUrl) {
        allowLeave();
        navigate(returnTarget(launch.returnUrl, 'saved', result.masterId));
      }
      else setSaved(result);
    } catch (e) {
      if (e instanceof DmsCommitRefused) {
        setChecked({ doc: sent, issues: e.issues, confirmed: e.needsConfirmation ? e.warningKey : null });
      } else if (e instanceof RemovalCancelled) {
        /* Cancel puts the block back and sends nothing. Other marked fields stay marked and are asked about again on the next save. */
        if (!restore(e.fieldId)) {
          setProblem('The field could not be put back. Reload this page to start again; nothing was changed in DMS.');
        }
      } else if (e instanceof DmsAuthError) setSignedOut(true);
      else {
        /* SCHEMA_SYNC_FAILED with saved:true: DMS holds this doc already (and, on a create, the master exists), so it is the new baseline. */
        if (schemaSyncOf(e)?.saved) {
          /* `current` is set by the failed commit itself; typed as read now (the `wasCreating` alias would narrow it to null). */
          const adopted = repo.current as { id: string } | null;
          if (wasCreating && adopted) rememberMasterId('dms-master', adopted.id);
          setBaseline(sent);
          setChecked(null);
          setProblemSaved(true);
        }
        setProblem(describeDmsError(e));
        setProblemRef(referenceLine(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (launch.returnUrl) navigate(returnTarget(launch.returnUrl, 'cancelled'));
  }

  if (signedOut) {
    return (
      <Message title="Sign in to DMS again">
        <p>Your DMS session has ended. Your changes are still on this page; sign in to DMS in another tab, then press Save to DMS again.</p>
        <Button onClick={() => setSignedOut(false)}>Back to the form</Button>
      </Message>
    );
  }
  if (saved) {
    return (
      <Message title="Saved to DMS">
        <p>The master was saved. You can close this tab and go back to DMS.</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const needsConfirm = errors.length === 0 && warnings.length > 0 && confirmed !== null;

  return (
    <RevealCtx.Provider value={repo.current?.canReveal ?? null}>
      <BuilderDnd>
        <div className="flex h-svh bg-background text-foreground" data-testid="dms-master-builder">
          <FieldPicker />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-[45px] shrink-0 items-center gap-1 border-b border-border bg-background px-3">
              {!sidebarOpen && (
                <Tooltip content="Open sidebar">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
                    <PanelLeft className="size-4" />
                  </Button>
                </Tooltip>
              )}
              <div className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
                <span className="text-foreground">{doc.title || 'Master name'}</span>
                <span className="ml-2 text-[13px] text-text-subtle" role="status">
                  {creating ? 'New master' : dirty ? 'Changes not saved to DMS' : 'Saved in DMS'}
                </span>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={undo}>
                <Undo2 className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={redo}>
                <Redo2 className="size-4" />
              </Button>
              {launch.returnUrl ? (
                <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving...' : needsConfirm ? 'Save anyway' : 'Save to DMS'}
              </Button>
            </header>
            <SessionBanners />
            {hiddenCount > 0 ? (
              <div className="p-2 pb-0">
                <Alert variant="info" data-testid="fp-hidden-count-banner">
                  <AlertDescription>
                    {hiddenCount === 1 ? '1 hidden field you cannot see is kept' : `${hiddenCount} hidden fields you cannot see are kept`}. DMS keeps them and their values when you save.
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
            {marks.length > 0 ? (
              <div className="p-2 pb-0">
                <RemovalMarks marks={marks} onRestore={(id) => void restore(id)} />
              </div>
            ) : null}
            {problem || issues.length > 0 ? (
              <div className="space-y-1 p-2" aria-live="polite">
                {problem ? (
                  <Alert variant="destructive">
                    <AlertTitle>{problemSaved ? 'Saved, but the data table needs another save' : 'The master was not saved'}</AlertTitle>
                    <AlertDescription>
                      {problem}
                      {problemRef ? <span className="mt-1 block text-[13px]" data-testid="fp-error-reference">{problemRef}</span> : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {errors.length > 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Fix these before saving</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-5">
                        {errors.map((i, n) => (
                          <li key={`${i.code}-${i.blockId ?? n}`}>
                            {i.blockId ? (
                              <button type="button" className="text-left underline" onClick={() => goTo(i.blockId)}>
                                {blockText(currentDoc().blocks[i.blockId as BlockId]) || 'This field'}: {i.message}
                              </button>
                            ) : (
                              i.message
                            )}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {warnings.length > 0 ? (
                  <Alert variant="warning">
                    <AlertTitle>DMS keeps less than the builder shows</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-5">
                        {warnings.map((i, n) => (
                          <li key={`${i.code}-${i.blockId ?? n}`}>
                            {i.blockId ? `${blockText(currentDoc().blocks[i.blockId as BlockId]) || 'A field'}: ` : ''}
                            {i.message}
                          </li>
                        ))}
                      </ul>
                      {needsConfirm ? <p className="mt-1">Press Save anyway to continue without them.</p> : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ErrorBoundary key="edit" label="canvas">
                  <FormCanvas />
                </ErrorBoundary>
              </div>
              <BlockInspector />
            </div>
          </div>
          <DeleteBlockDialog />
          <RemovalDialog pending={consent.pending} />
        </div>
      </BuilderDnd>
    </RevealCtx.Provider>
  );
}
