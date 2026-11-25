import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FormRenderer, type RendererHandle } from '@form/renderer';
import { answerToDms } from '@form/registry/profiles/dms-v1';
import type { Answers, FileRef, Locale } from '@form/schema';
import { Alert, AlertDescription, AlertTitle, Button } from '@dmacq/ui';
import { BUILDER_LOCALE } from '@/i18n';
import { DmsApiError, DmsAuthError } from '@/embed/dmsClient';
import { currentLaunch, type ResolvedLaunch } from '@/embed/launch';
import { ProfileProvider } from '@/embed/profile';
import { fieldNameOf, recordReturnTarget, writableElements, type DmsRecordValues, type LoadedDmsRecord } from './contract';
import { describeRecordError } from './describeRecordError';
import { DmsRecordRepository } from './DmsRecordRepository';
import { planRecordForm, viewerClock, type RecordForm } from './recordForm';

/*
 * `/embed/dms-record` (DESIGN-v2 section 4): add or edit ONE record of a Forms+ master with the user's own DMS token. Outside
 * the fORM- session. Nothing is written until Save; an unchanged edit sends nothing; DMS keeps the permissions.
 */

const LAUNCH_TEXT = {
  missing: 'Open this page from DMS. It starts with the master you chose and cannot be opened on its own.',
  malformed: 'DMS sent a launch link this page cannot read. Go back to DMS and try again.',
  invalid: 'DMS sent a launch link with missing or unexpected details. Go back to DMS and try again.',
  wrong_mode: 'This launch link is for another DMS screen. Go back to DMS and try again.',
  api_origin_rejected: 'This launch link points at a DMS server this page is not set up to talk to, so nothing was sent to it.',
} as const;

const refuseUpload = (): Promise<FileRef> => Promise.reject(new Error('Files are not part of a record form'));

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
      <h1 className="text-[28px] font-bold">{title}</h1>
      <div className="mt-2 space-y-4 text-[15px] text-muted-foreground">{children}</div>
    </main>
  );
}

function BackToDms({ launch, loaded }: { launch: ResolvedLaunch; loaded?: LoadedDmsRecord | null }) {
  if (!launch.returnUrl || !launch.masterId) return null;
  const href = loaded ? recordReturnTarget(launch.returnUrl, 'cancelled', launch.masterId) : launch.returnUrl;
  return (
    <p>
      <a className="underline" href={href}>
        Back to DMS
      </a>
    </p>
  );
}

export function DmsRecordPage({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const resolved = useMemo(() => currentLaunch('dms-record'), []);
  if (!resolved.ok) {
    return (
      <Message title="This page was not opened from DMS">
        <p>{LAUNCH_TEXT[resolved.reason]}</p>
      </Message>
    );
  }
  if (resolved.launch.masterId === undefined) return <Message title="This page was not opened from DMS"><p>{LAUNCH_TEXT.invalid}</p></Message>;
  return (
    <ProfileProvider profile="dms-v1">
      <RecordApp launch={resolved.launch} navigate={navigate} />
    </ProfileProvider>
  );
}

type Load =
  | { state: 'loading' }
  | { state: 'signedOut' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; loaded: LoadedDmsRecord; form: RecordForm | null; formError: string | null };

function RecordApp({ launch, navigate }: { launch: ResolvedLaunch; navigate: (url: string) => void }) {
  const repo = useMemo(() => new DmsRecordRepository(launch), [launch]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    repo
      .load(launch.masterId as string, launch.recordId)
      .then((loaded) => {
        if (!live) return;
        const planned = loaded.source === 'formplus' ? planRecordForm(loaded.elements, loaded.values, loaded.masterName, viewerClock(), loaded.recordId) : null;
        setLoad({ state: 'ready', loaded, form: planned?.ok ? planned.form : null, formError: planned && !planned.ok ? planned.message : null });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoad(e instanceof DmsAuthError ? { state: 'signedOut' } : { state: 'failed', message: e instanceof DmsApiError && e.status === 404 ? 'DMS has no such master or record.' : describeRecordError(e)[0] ?? '' });
      });
    return () => {
      live = false;
    };
  }, [repo, launch.masterId, launch.recordId]);

  if (load.state === 'loading') return <main className="h-svh bg-background" aria-busy="true" data-testid="dms-record-loading" />;
  if (load.state === 'signedOut') {
    return (
      <Message title="Sign in to DMS again">
        <p>Your DMS session has ended, so the record could not be opened. Sign in to DMS, then open it again.</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  if (load.state === 'failed') {
    return (
      <Message title="This record cannot be opened">
        <p>{load.message}</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  if (load.loaded.source !== 'formplus') {
    return (
      <Message title="This master has not been converted to Forms+">
        <p>Records of this master cannot be added or edited here yet. Ask an administrator to convert the master, then try again.</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  if (!load.form) {
    return (
      <Message title="This record cannot be shown">
        <p>{load.formError ?? 'The master has no fields this page can show.'}</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  return <RecordEditor repo={repo} launch={launch} loaded={load.loaded} form={load.form} navigate={navigate} />;
}

function RecordEditor({ repo, launch, loaded, form, navigate }: { repo: DmsRecordRepository; launch: ResolvedLaunch; loaded: LoadedDmsRecord; form: RecordForm; navigate: (url: string) => void }) {
  const handle = useRef<RendererHandle | null>(null);
  const answers = useRef<Answers>(form.initialAnswers);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const adding = loaded.recordId === null;

  /* Typed values are the only copy until Save. */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** Every field's DMS string by name; a field the person did not touch keeps the exact string DMS stored. */
  function collect(): DmsRecordValues {
    const out: DmsRecordValues = {};
    for (const el of writableElements(loaded.elements)) {
      const id = String(el.id);
      const name = fieldNameOf(el);
      const block = form.blocks[id];
      const answer = answers.current[id as keyof Answers];
      out[name] = !block || (!adding && JSON.stringify(answer ?? null) === form.baseline[id]) ? (loaded.values[name] ?? '') : answerToDms(block, (answer as { value?: never } | undefined)?.value);
    }
    return out;
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setProblems([]);
    try {
      const errors = (await handle.current?.validate()) ?? [];
      /* A field nobody touched keeps what DMS stores (an edit never sends it), even if it breaks today's rule. */
      const blocking = errors.filter((e) => {
        const id = e.blockId as string | undefined;
        if (id === undefined) return true;
        const touched = JSON.stringify(answers.current[id as keyof Answers] ?? null) !== form.baseline[id];
        return touched || form.baseline[id] === 'null';
      });
      if (blocking.length > 0) return;
      const { recordId } = await repo.save(loaded, collect());
      setDirty(false);
      if (launch.returnUrl) navigate(recordReturnTarget(launch.returnUrl, 'saved', loaded.masterId, recordId));
      else setSavedId(recordId);
    } catch (e) {
      if (e instanceof DmsAuthError) setSignedOut(true);
      else setProblems(describeRecordError(e));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (launch.returnUrl) navigate(recordReturnTarget(launch.returnUrl, 'cancelled', loaded.masterId));
  }

  if (savedId) {
    return (
      <Message title="Saved to DMS">
        <p>The record was saved. You can close this tab and go back to DMS.</p>
        <BackToDms launch={launch} />
      </Message>
    );
  }
  return (
    <div className="min-h-svh bg-background text-foreground" data-testid="dms-record-page">
      <header className="mx-auto flex max-w-[720px] items-center gap-2 px-4 pt-6">
        <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold">
          {adding ? 'Add record' : 'Edit record'} <span className="font-normal text-muted-foreground">in {loaded.masterName}</span>
        </h1>
        {launch.returnUrl ? (
          <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy || signedOut}>
          {busy ? 'Saving...' : 'Save'}
        </Button>
      </header>
      {signedOut ? (
        <div className="mx-auto max-w-[720px] px-4 pt-4">
          <Alert variant="destructive" role="alert">
            <AlertTitle>Sign in to DMS again</AlertTitle>
            <AlertDescription>
              Your DMS session has ended. What you typed is still here; sign in to DMS in another tab, then{' '}
              <button type="button" className="underline" onClick={() => setSignedOut(false)}>
                try Save again
              </button>
              .
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <div className="mx-auto max-w-[720px] px-4 pt-4" aria-live="polite">
          <Alert variant="destructive">
            <AlertTitle>The record was not saved</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <FormRenderer
        version={form.version}
        mode="live"
        status={{ state: 'open' }}
        locale={BUILDER_LOCALE as Locale}
        initialAnswers={form.initialAnswers}
        session={{ startedAt: form.startedAt }}
        onSubmit={() => undefined}
        uploader={refuseUpload}
        hideNavigation
        onAnswersChange={(next) => {
          answers.current = next;
          setDirty(true);
        }}
        handleRef={handle}
      />
    </div>
  );
}
