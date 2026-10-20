import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react';
import { FormProvider, useForm, type FieldValues } from 'react-hook-form';
import { EN_IN, createI18n, type I18n } from '@form/i18n';
import { isAvailable } from '@form/registry';
import {
  isSafeUrl, type Block as SchemaBlock, type EndingId, type EvalMeta, type FieldError, type IsoInstant, type PageId, type PlainTemplate,
  type PublicFormDefinition, type SafeUrl, type SubmitResult,
} from '@form/schema';
import { loadRegexEngine, needsRegexEngine, type RawAnswers } from '@form/validation/lazy';
import { startingAnswers } from './answers.ts';
import { RendererContext, useRenderer, type RendererContextValue } from './context.ts';
import { usePipes } from './controls/hooks.ts';
import { useEvalSession, useEvaluation } from './eval/context.ts';
import { EvalProvider } from './eval/EvalProvider.tsx';
import type { EvalSession } from './eval/session.ts';
import { sessionMeta, todayIn } from './eval/meta.ts';
import { Block } from './fields/Field.tsx';
import { packRows } from './layout/rows.ts';
import { MESSAGES } from './messages.ts';
import { rhfResolver } from './rhfResolver.ts';
import { RichTextView } from './richtext/RichTextView.tsx';
import { EndingScreen } from './screens/Ending.tsx';
import { StatusScreen } from './screens/Status.tsx';
import { templateText, urlText } from './text.ts';
import { themeCssVars } from './theme/cssVars.ts';
import type { FormRendererProps, RendererEvent, RendererSession, SubmitPayload } from './types.ts';

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]';

/** Blocks the respondent sees on a page, in order: available, visible, not concealed and not hidden fields. */
function shownBlocks(def: PublicFormDefinition, pageId: PageId, visible: ReadonlySet<string>): SchemaBlock[] {
  const page = def.pages.find((p) => p.id === pageId);
  return (page?.children ?? []).flatMap((id): SchemaBlock[] => {
    const block = def.blocks[id];
    if (!block || block.type === 'unsupported' || !isAvailable(block.type) || block.type === 'hidden' || !visible.has(id)) return [];
    if ('concealed' in block && block.concealed) return [];
    return [block];
  });
}

interface PageViewProps {
  current: PageId;
  first: boolean;
  canGoBack: boolean;
  sending: boolean;
  /** Next/Submit is running (uploads, validation, the submission): further clicks are ignored. */
  busy: boolean;
  formErrors: FieldError[];
  failure: string | null;
  onBack: () => void;
}

/** The current page: header on the first page, progress, rows of blocks, form-level errors and navigation. */
function PageView({ current, first, canGoBack, sending, busy, formErrors, failure, onBack }: PageViewProps) {
  const { def, t, tokens, mode } = useRenderer();
  const { state } = useEvaluation();
  const { text, resolve } = usePipes();
  const page = def.pages.find((p) => p.id === current);
  const position = Math.max(0, state.path.indexOf(current));
  const total = state.path.length;
  const isLast = typeof state.nextPage(current) !== 'string';
  const rows = packRows(shownBlocks(def, current, state.visible));
  const progressLabel = t('system:progress.label', { current: position + 1, total });
  const nextLabel = isLast ? text(def.behavior.submit.label) || t('system:nav.submit') : text(page?.nav?.nextLabel) || t('system:nav.next');
  return (
    <>
      {tokens.progress !== 'none' && total > 1 ? (
        tokens.progress === 'bar' ? (
          <div className="fr-progress" role="progressbar" aria-label={progressLabel} aria-valuemin={1} aria-valuemax={total} aria-valuenow={position + 1}>
            <div className="fr-progress-fill" style={{ width: `${((position + 1) / total) * 100}%` }} />
          </div>
        ) : (
          <p className="fr-progress-text">
            {tokens.progress === 'percent' ? t(MESSAGES['progress.percent'], { percent: Math.round(((position + 1) / total) * 100) }) : progressLabel}
          </p>
        )
      ) : null}
      {first && (def.title || def.description || mode === 'preview') ? (
        <header className="fr-header">
          {def.title ? (
            <h1 className="fr-title">{def.title}</h1>
          ) : mode === 'preview' ? (
            <h1 className="fr-title fr-title-placeholder">{t(MESSAGES['title.untitled'])}</h1>
          ) : null}
          {def.description ? <div className="fr-description fr-rich"><RichTextView doc={def.description} resolve={resolve} /></div> : null}
        </header>
      ) : null}
      {def.behavior.navigation.showPageTitles && page?.title ? <h2 className="fr-page-title">{text(page.title)}</h2> : null}
      <div className="fr-blocks">
        {rows.map((row) => (
          <div key={row.map((p) => p.block.id).join('|')} className="fr-row">
            {row.map(({ block, span }) => (
              <div key={block.id} className="fr-cell" style={{ '--fr-span': span } as CSSProperties}>
                <Block block={block} />
              </div>
            ))}
          </div>
        ))}
      </div>
      {formErrors.length || failure ? (
        <div className="fr-form-error" role="alert">
          {formErrors.map((e, i) => <p key={i}>{e.message}</p>)}
          {failure ? <p>{failure}</p> : null}
        </div>
      ) : null}
      <div className="fr-nav" data-align={isLast ? def.behavior.submit.align : 'left'}>
        {canGoBack && page?.nav?.showBack !== false ? (
          <button type="button" className="fr-button fr-secondary" onClick={onBack} disabled={sending}>
            {text(page?.nav?.backLabel) || t('system:nav.back')}
          </button>
        ) : null}
        {page?.nav?.showNext === false && !isLast ? null : (
          <button type="submit" className="fr-button fr-primary" disabled={sending} aria-disabled={busy || undefined} aria-busy={busy || undefined}>
            {sending ? t(MESSAGES['submit.sending']) : nextLabel}
          </button>
        )}
      </div>
    </>
  );
}

interface Finished { endingId: EndingId; redirect: SafeUrl | null }

/** One respondent session: answers in react-hook-form, logic in an EvalSession, paging, submit and the ending. */
function FormSession({ props, meta, base, onRestart }: {
  props: FormRendererProps;
  meta: EvalMeta;
  base: Omit<RendererContextValue, 'revalidate' | 'track'>;
  onRestart: () => void;
}) {
  const { version, locale, onSubmit, onEvent, onPartialSave, initialAnswers, mode } = props;
  const def = version.definition;
  const today = todayIn(meta.now, meta.timeZone);
  const session: EvalSession = useEvalSession(version, meta);
  const [defaults] = useState(() => startingAnswers(def, initialAnswers, today, { def, values: {}, meta, now: meta.now }));
  const validation = useMemo(
    () => rhfResolver(version, session, () => ({ locale, today, messages: base.i18n, ...(meta.holidayCalendars ? { holidayCalendars: meta.holidayCalendars } : {}) })),
    [version, session, locale, today, base.i18n, meta.holidayCalendars],
  );
  const form = useForm<FieldValues>({ resolver: validation.resolver, defaultValues: defaults, mode: 'onSubmit', shouldUnregister: false });
  const pending = useRef(new Set<Promise<unknown>>());
  const [welcomed, setWelcomed] = useState(!def.welcome?.enabled);
  const [trail, setTrail] = useState<PageId[]>([]);
  const [pageId, setPageId] = useState<PageId | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const advancing = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const rootRef = useRef<HTMLFormElement>(null);

  /* re2js loads only for forms that match text against a pattern, preset or mask; the resolver waits for it. */
  useEffect(() => {
    if (needsRegexEngine(def)) loadRegexEngine().catch(() => undefined);
  }, [def]);

  const emit = useCallback((event: RendererEvent) => onEvent?.(event), [onEvent]);
  const { getFieldState, trigger } = form;
  const revalidate = useCallback((blockId: string) => {
    if (getFieldState(blockId).error) void trigger(blockId);
  }, [getFieldState, trigger]);
  const track = useCallback(<T,>(work: Promise<T>): Promise<T> => {
    pending.current.add(work);
    const done = () => pending.current.delete(work);
    work.then(done, done);
    return work;
  }, []);
  const context = useMemo<RendererContextValue>(() => ({ ...base, revalidate, track }), [base, revalidate, track]);

  const evaluateNow = () => session.evaluate(form.getValues() as RawAnswers);
  const currentPage = (path: readonly PageId[]): PageId => pageId ?? path[0] ?? (def.pages[0]?.id as PageId);

  /**
   * Shows errors. A field error on an earlier page (a server result, or Submit validating the whole path) takes the
   * respondent back to that page; an error on no reachable page is shown with the form-level errors.
   */
  const invalid = (errors: FieldError[], current: PageId) => {
    const pageOf = version.compiled.pageOf;
    const reachable = (blockId: FieldError['blockId']) => {
      const page = blockId === undefined ? undefined : pageOf[blockId];
      return page !== undefined && (page === current || trail.includes(page));
    };
    setFormErrors(errors.filter((e) => !reachable(e.blockId)));
    setAnnouncement(base.t(MESSAGES['errors.summary'], { count: errors.length }));
    emit({ type: 'invalid', errors });
    const first = errors.find((e) => reachable(e.blockId));
    if (!first?.blockId) return;
    const target = first.blockId;
    const page = pageOf[target] as PageId;
    if (page !== current) {
      const at = trail.indexOf(page);
      setTrail(trail.slice(0, at));
      setPageId(page);
      emit({ type: 'page', pageId: page, index: at });
    }
    if (!def.behavior.a11y.focusFirstError) return;
    requestAnimationFrame(() => {
      const field = rootRef.current?.ownerDocument.getElementById(`${base.idFor(target)}-field`);
      field?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
  };

  const finish = (endingId: EndingId, serverRedirect: SafeUrl | undefined, values: ReturnType<typeof evaluateNow>['state']['values']) => {
    const ending = def.endings.find((e) => e.id === endingId) ?? def.endings.find((e) => e.id === def.defaultEndingId) ?? def.endings[0];
    /* Live redirects come from the server, which interpolates the URL (schema §END); preview builds it here. */
    const url = serverRedirect ?? (mode === 'preview' && ending?.kind === 'redirect' ? urlText(ending.url as PlainTemplate, { def, values, meta }) : '');
    const redirect = /^https:/i.test(url) && isSafeUrl(url) ? (url as SafeUrl) : null;
    setFinished({ endingId: ending?.id ?? endingId, redirect });
    emit({ type: 'submitted', endingId: ending?.id ?? endingId });
    /* The host navigates (the top window, a popup's opener, or nowhere in the builder), after `delayMs`. */
    if (redirect) emit({ type: 'redirect', url: redirect, delayMs: ending?.kind === 'redirect' ? (ending.delayMs ?? 0) : 0 });
  };

  const submit = async (current: PageId) => {
    const { state } = evaluateNow();
    const client: SubmitPayload['client'] = { startedAt: meta.now };
    if (Object.keys(meta.urlParams).length) client.urlParams = { ...meta.urlParams };
    if (meta.device) client.device = meta.device;
    if (meta.pageUrl !== undefined) client.pageUrl = meta.pageUrl;
    if (meta.referrer !== undefined) client.referrer = meta.referrer;
    if (meta.embedOrigin !== undefined) client.embedOrigin = meta.embedOrigin;
    const payload: SubmitPayload = { formVersionId: version.versionId, locale, answers: state.values, pageTrail: [...trail, current], client };
    setSending(true);
    setFailure(null);
    let result: SubmitResult | void;
    try {
      result = await onSubmit(payload);
    } catch {
      setSending(false);
      setFailure(base.t(MESSAGES['submit.failed']));
      emit({ type: 'submit_failed', result: { ok: false, kind: 'error' } });
      return;
    }
    setSending(false);
    if (!result || result.ok) {
      finish(result?.endingId ?? state.endingId, result?.redirectUrl, state.values);
      return;
    }
    emit({ type: 'submit_failed', result });
    if (result.kind === 'invalid') {
      for (const error of result.errors) {
        if (error.blockId !== undefined) form.setError(error.blockId, { type: error.code, message: error.message });
      }
      invalid(result.errors, current);
      return;
    }
    const closed = result.kind === 'closed' ? 'system:form.closed' : result.kind === 'limit_reached' ? 'system:form.limit_reached' : null;
    setFailure(base.t(closed ?? MESSAGES['submit.failed']));
  };

  const step = async () => {
    /* An upload can start another (a signature's PNG, then its upload): wait until none is left. */
    while (pending.current.size) await Promise.allSettled([...pending.current]);
    const { state } = evaluateNow();
    const current = currentPage(state.path);
    const next = state.nextPage(current);
    const isLast = typeof next !== 'string';
    validation.scope(isLast ? 'submit' : { page: current });
    let ok: boolean;
    try {
      ok = await form.trigger();
    } catch {
      /* The regex engine could not load (offline): nothing was validated, so nothing moves on. */
      setFailure(base.t(MESSAGES['submit.failed']));
      return;
    }
    setFailure(null);
    const errors = validation.errors();
    if (!ok || errors.length) {
      invalid(errors, current);
      return;
    }
    setFormErrors([]);
    setAnnouncement('');
    if (isLast) {
      await submit(current);
      return;
    }
    setTrail([...trail, current]);
    setPageId(next);
    emit({ type: 'page', pageId: next, index: state.path.indexOf(next) });
    onPartialSave?.({ formVersionId: version.versionId, answers: state.values, currentPageId: next });
    requestAnimationFrame(() => rootRef.current?.focus());
  };

  /* One Next/Submit at a time: a click while uploads, the regex engine or the submission are pending is ignored. */
  const advance = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (advancing.current) return;
    advancing.current = true;
    setBusy(true);
    try {
      await step();
    } finally {
      advancing.current = false;
      setBusy(false);
    }
  };

  const back = () => {
    const previous = trail[trail.length - 1];
    if (previous === undefined) return;
    setTrail(trail.slice(0, -1));
    setPageId(previous);
    setFormErrors([]);
    form.clearErrors();
    emit({ type: 'page', pageId: previous, index: trail.length - 1 });
    requestAnimationFrame(() => rootRef.current?.focus());
  };

  /* "Submit another response" is a new session: FormRenderer remounts it with a new `meta.now`. */
  const restart = () => {
    emit({ type: 'restart' });
    onRestart();
  };

  let screen;
  if (finished) {
    const ending = def.endings.find((e) => e.id === finished.endingId);
    const { state } = evaluateNow();
    const ctx = { def, values: state.values, meta };
    screen = ending ? (
      <EndingScreen
        ending={ending}
        confetti={def.behavior.successAnimation && (ending.kind === 'message' ? ending.confetti !== false : false)}
        resolve={{ pipe: (attrs) => templateText([{ pipe: attrs }], ctx) || undefined }}
        url={(value) => urlText(value, ctx)}
        redirecting={finished.redirect !== null && mode === 'live'}
        onRestart={restart}
      />
    ) : null;
  } else if (!welcomed && def.welcome) {
    screen = (
      <div className="fr-screen fr-welcome">
        <div className="fr-rich"><RichTextView doc={def.welcome.content} /></div>
        <button
          type="button"
          className="fr-button fr-primary"
          onClick={() => {
            setWelcomed(true);
            emit({ type: 'start' });
          }}
        >
          {def.welcome.startLabel?.trim() || base.t('system:nav.start')}
        </button>
      </div>
    );
  } else {
    screen = (
      <EvalProvider session={session} control={form.control as never}>
        <SessionForm
          formRef={rootRef}
          onSubmit={(e) => void advance(e)}
          pageId={pageId}
          trail={trail}
          sending={sending}
          busy={busy}
          formErrors={formErrors}
          failure={failure}
          onBack={back}
        />
      </EvalProvider>
    );
  }

  return (
    <RendererContext.Provider value={context}>
      <FormProvider {...form}>
        {screen}
        <div className="fr-sr-only" role="status" aria-live={def.behavior.a11y.announceErrors}>{announcement}</div>
      </FormProvider>
    </RendererContext.Provider>
  );
}

function SessionForm({ formRef, onSubmit, pageId, trail, ...rest }: {
  formRef: RefObject<HTMLFormElement | null>;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  pageId: PageId | null;
  trail: readonly PageId[];
} & Omit<PageViewProps, 'current' | 'first' | 'canGoBack'>) {
  const { def } = useRenderer();
  const { state } = useEvaluation();
  const current = pageId ?? state.path[0] ?? (def.pages[0]?.id as PageId);
  return (
    <form ref={formRef} className="fr-form" noValidate tabIndex={-1} onSubmit={onSubmit} aria-label={def.title || undefined}>
      <PageView current={current} first={trail.length === 0} canGoBack={def.behavior.navigation.allowBack && trail.length > 0} {...rest} />
    </form>
  );
}

/**
 * FND-04: the respondent UI for one runtime version, independent of any store. Everything outside (submission,
 * uploads, status changes, navigation, analytics) goes through props and `onEvent`. Server-renderable: no `window`
 * or `document` at module scope or during render, ids from `useId`, the session clock from `session.startedAt`.
 */
export function FormRenderer(props: FormRendererProps) {
  const { version, mode, status, locale, messages, theme, session, uploader, onEvent, onUnlock } = props;
  const def = version.definition;
  const rootId = useId();
  const i18n: I18n = useMemo(() => createI18n(locale, messages ?? EN_IN, { fallback: EN_IN }), [locale, messages]);
  /* The session clock (`meta.now`) is read once per session: at mount, and again when the respondent restarts. */
  const [run, setRun] = useState(() => ({ count: 0, startedAt: session?.startedAt ?? (new Date().toISOString() as IsoInstant) }));
  const startedAt = run.startedAt;
  /* A host may pass a new session object each render; it is compared by value. */
  const sessionKey = JSON.stringify(session ?? {});
  const stableSession = useMemo(() => JSON.parse(sessionKey) as RendererSession, [sessionKey]);
  const meta = useMemo(() => sessionMeta(version, locale, mode, stableSession, startedAt), [version, locale, mode, stableSession, startedAt]);
  const tokens = (theme ?? def.theme).tokens;
  const base = useMemo<Omit<RendererContextValue, 'revalidate' | 'track'>>(
    () => ({
      version,
      def,
      tokens,
      mode,
      meta,
      i18n,
      t: (id, values) => i18n.t(id, values),
      uploader,
      idFor: (blockId) => `${rootId}${blockId}`,
    }),
    [version, def, tokens, mode, meta, i18n, uploader, rootId],
  );
  const pinned = stableSession.startedAt;
  const restart = useCallback(() => setRun((r) => ({ count: r.count + 1, startedAt: pinned ?? (new Date().toISOString() as IsoInstant) })), [pinned]);
  const dir = def.i18n.locales.find((l) => l.locale === locale)?.direction ?? 'ltr';
  return (
    <div
      className="fr-root"
      lang={locale}
      dir={dir}
      style={themeCssVars(tokens)}
      data-input-style={tokens.inputStyle}
      data-label-align={tokens.labelAlign}
      data-density={tokens.density}
      data-layout={(theme ?? def.theme).layout}
      data-mode={mode}
    >
      {status.state === 'open' ? (
        <FormSession key={`${version.versionId}:${run.count}`} props={props} meta={meta} base={base} onRestart={restart} />
      ) : (
        <RendererContext.Provider value={{ ...base, revalidate: () => undefined, track: (work) => work }}>
          <StatusScreen status={status} onEvent={onEvent} onUnlock={onUnlock} />
        </RendererContext.Provider>
      )}
    </div>
  );
}
