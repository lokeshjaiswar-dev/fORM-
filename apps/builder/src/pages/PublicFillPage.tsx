import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { runtimeEdition } from '@form/config';
import { defineMessages } from '@form/i18n';
import { FormRenderer, browserSession, type RendererSession, type SubmitAccepted, type SubmitPayload } from '@form/renderer';
import '@form/renderer/styles.css';
import type { Answers, BlockId, EndingId, FieldError, IsoInstant, PublicFormDefinition, RuntimeFormVersion, RuntimeStatus, SubmissionId, SubmitResult } from '@form/schema';
import { Alert, AlertDescription, AlertTitle, Button } from '@dmacq/ui';
import { hydrateThemeImages } from '@/components/builder/design/uploads';
import { useEdition } from '@/edition/edition';
import { BUILDER_LOCALE, t } from '@/i18n';
import { blankDefinition } from '@/lib/definition';
import { carryAnswers } from '@/lib/carryAnswers';
import { previewVersion } from '@/lib/preview';
import { answerRows } from '@/persistence/answerRows';
import { publicUploader } from '@/persistence/filesApi';
import {
  addressWithoutQuery,
  browserTimeZone,
  deviceOf,
  fetchPublicForm,
  originOf,
  submitPublicForm,
  unlockPublicForm,
  uuidv7,
  type SubmissionBody,
} from '@/persistence/publicFillApi';

const M = defineMessages('builder', {
  'fill.not_found_title': 'Form not found',
  'fill.not_found_body': 'This link is not a published form.',
  'fill.error_title': 'This form cannot be opened',
  'fill.load_failed': 'This form could not be loaded.',
  'fill.password_wrong': 'That password is not right. Check it and try again.',
  'fill.password_rate_limited': 'Too many attempts. Wait a few minutes and try again.',
  'fill.password_failed': 'The password could not be checked just now. Try again.',
  'fill.superseded': 'This form was updated while you were filling it.',
  'fill.superseded_hint': 'Load the new version. Your answers to the questions that are still there are kept.',
  'fill.superseded_reload': 'Reload with my answers',
  'fill.reload_failed': 'The new version could not be loaded just now. Try again.',
  'fill.under_review': 'Your submission is under review',
  'fill.under_review_hint': 'It has been received. A reviewer has to check it before it is final, so it may take a while to be confirmed.',
});

/** What the page shows once the API has answered. `version` is null for a form behind its password (the definition is withheld) or a status the server would not open. */
type Page =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'ready'; slug: string; status: RuntimeStatus; version: RuntimeFormVersion | null; answers: Answers | undefined; generation: number };

type UnlockError = 'wrong' | 'rate_limited' | 'failed';

/**
 * The page view's session: the clock, and what the browser knows (URL/UTM parameters, referrer, user agent, embedding
 * origin) for context fields. The renderer never reads `window` itself, so the host passes it in. What is kept of the
 * address and the referrer is what the server stores: the address without its query (it can hold tokens and prefilled
 * personal data; the parameters themselves still go along as `urlParams`, for hidden fields) and the referrer's site.
 */
function sessionOfPage(): RendererSession {
  const { pageUrl: fullUrl, referrer: fullReferrer, ...seen } = browserSession();
  const pageUrl = addressWithoutQuery(fullUrl);
  const referrer = originOf(fullReferrer);
  return {
    ...seen,
    startedAt: new Date().toISOString() as IsoInstant,
    ...(pageUrl !== undefined ? { pageUrl } : {}),
    ...(referrer !== undefined ? { referrer } : {}),
    device: deviceOf(typeof window === 'undefined' ? 1280 : window.innerWidth),
  };
}

/** A field error the server named (`blockId.path`) as the renderer shows it: next to the field when the form has it, in the summary when it does not. */
function fieldErrors(errors: Array<{ path: string; message: string }>, definition: PublicFormDefinition): FieldError[] {
  return errors.map((e) => {
    const blockId = e.path.split('.')[0] ?? '';
    return Object.hasOwn(definition.blocks, blockId)
      ? { blockId: blockId as BlockId, code: 'invalid_format', message: e.message }
      : { code: 'invalid_format', message: e.path ? `${e.path}: ${e.message}` : e.message };
  });
}

/*
 * A respondent is anonymous: these calls never carry the session cookie (publicFillApi.ts). The page asks the API for the
 * form's status and shows what a respondent may do now: the form when it is open, otherwise the screen for the status
 * (closed, not yet open, outside hours, full), or a password prompt, which unlocks on the server and keeps the token in
 * memory only. An old address follows the redirect the API gives. A submission carries an Idempotency-Key (one per
 * attempt, the same for a retry of the same answers), and the API's refusals map to what the renderer can show.
 */
export function PublicFillPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const edition = runtimeEdition(useEdition());
  const [page, setPage] = useState<Page>({ kind: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [unlockError, setUnlockError] = useState<UnlockError | null>(null);
  const [superseded, setSuperseded] = useState<{ answers: Answers; from: PublicFormDefinition } | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  /** The last submission was received but is kept until a reviewer has checked it (the API answered `held: 'pending_review'`). */
  const [underReview, setUnderReview] = useState(false);
  const [session] = useState(sessionOfPage);
  const uploader = useMemo(() => publicUploader(slug), [slug]);
  /** The access token of an unlock. In memory only: a reload asks for the password again, and nothing is stored. */
  const token = useRef<string | null>(null);
  /** The Idempotency-Key of the submission being tried, with the request it belongs to: a retry of the same request reuses it. */
  const attempt = useRef<{ request: string; key: string } | null>(null);
  /** How many times this page view was sent on to a form's newer address. */
  const hops = useRef(0);
  const generation = useRef(0);

  /** What stands in for a form's own version when the server withholds it: a blank form, so the status screen has a theme and words to use. */
  const shell = useMemo(() => {
    if (session.startedAt === undefined) return null;
    const built = previewVersion(blankDefinition('status-screen'), { state: 'open' }, session.startedAt, edition);
    return built.ok ? built.version : null;
  }, [session.startedAt, edition]);

  useEffect(() => {
    let live = true;
    const open = async () => {
      let last: Page = { kind: 'error' };
      for (let tries = 0; tries < 4 && live; tries++) {
        try {
          const found = await fetchPublicForm(slug, token.current);
          if (found.kind === 'missing') {
            last = { kind: 'missing' };
            break;
          }
          if (found.kind === 'redirect') {
            // The address is one the form used to have: move to the current one. A few hops at most, so a loop cannot hold the page.
            if (found.slug !== slug && hops.current < 3) {
              hops.current += 1;
              if (live) navigate(`/f/${encodeURIComponent(found.slug)}`, { replace: true });
              return;
            }
            break;
          }
          hydrateThemeImages(found.media);
          generation.current += 1;
          last = { kind: 'ready', slug: found.slug, status: found.status, version: found.version, answers: undefined, generation: generation.current };
          break;
        } catch {
          last = { kind: 'error' };
        }
        if (tries < 3) await new Promise((r) => setTimeout(r, 800 * (tries + 1)));
      }
      if (live) setPage(last);
    };
    void open();
    return () => {
      live = false;
    };
  }, [slug, reloads, navigate]);

  /** Asks the API again, from the top: a status that changed, a token that ended, a form that was unpublished. */
  const reload = () => {
    setPage({ kind: 'loading' });
    setSuperseded(null);
    setReloads((n) => n + 1);
  };

  if (page.kind === 'loading') return <main className="min-h-svh bg-white" aria-busy="true" />;
  if (page.kind !== 'ready') {
    return (
      <main className="mx-auto max-w-[640px] px-6 py-16 text-foreground">
        <h1 className="text-[28px] font-bold">{t(page.kind === 'missing' ? M['fill.not_found_title'] : M['fill.error_title'])}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{t(page.kind === 'missing' ? M['fill.not_found_body'] : M['fill.load_failed'])}</p>
      </main>
    );
  }

  const { version, status } = page;
  const shown = version ?? shell;
  if (shown === null || (version === null && status.state === 'open')) {
    return (
      <main className="mx-auto max-w-[640px] px-6 py-16 text-foreground">
        <h1 className="text-[28px] font-bold">{t(M['fill.error_title'])}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{t(M['fill.load_failed'])}</p>
      </main>
    );
  }

  // Answer in one of the form's own locales: the server refuses any other. Locale detection (?lang=, browser) is
  // WP-1.21 work; until then use the builder's locale when the form has it, otherwise the form's default.
  const { i18n } = shown.definition;
  const locale = i18n.locales.some((l) => l.locale === BUILDER_LOCALE) ? BUILDER_LOCALE : i18n.defaultLocale;

  /** Unlocks on the server; the token it gives is kept in memory and the page is asked for again with it. */
  const unlock = async (password: string) => {
    setUnlockError(null);
    try {
      const result = await unlockPublicForm(slug, password);
      if (result.kind === 'ok') {
        token.current = result.accessToken;
        reload();
      } else if (result.kind === 'missing') reload();
      else setUnlockError(result.kind === 'wrong' ? 'wrong' : 'rate_limited');
    } catch {
      setUnlockError('failed');
    }
  };

  /** Loads the form again after it was republished, and carries the answers over by field key. */
  const reloadWithAnswers = async () => {
    if (superseded === null) return;
    setReloadFailed(false);
    try {
      const found = await fetchPublicForm(slug, token.current);
      if (found.kind !== 'form' || found.version === null) {
        reload();
        return;
      }
      hydrateThemeImages(found.media);
      generation.current += 1;
      setPage({
        kind: 'ready',
        slug: found.slug,
        status: found.status,
        version: found.version,
        answers: carryAnswers(superseded.from, found.version.definition, superseded.answers),
        generation: generation.current,
      });
      setSuperseded(null);
    } catch {
      setReloadFailed(true);
    }
  };

  const submit = async (payload: SubmitPayload): Promise<SubmitResult | SubmitAccepted | void> => {
    if (version === null) throw new Error('This form is not open.');
    const timeZone = browserTimeZone();
    const pageUrl = addressWithoutQuery(payload.client.pageUrl);
    const referrer = originOf(payload.client.referrer);
    const body: SubmissionBody = {
      formVersionId: payload.formVersionId,
      answers: payload.answers,
      fields: answerRows(version.definition, payload.answers),
      locale: payload.locale,
      // Advisory: the server evaluates again with these, and stores the address without its query and the referrer's host.
      client: {
        startedAt: payload.client.startedAt,
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(payload.client.urlParams !== undefined ? { urlParams: payload.client.urlParams } : {}),
        ...(pageUrl !== undefined ? { pageUrl } : {}),
        ...(referrer !== undefined ? { referrer } : {}),
        ...(payload.client.device !== undefined ? { device: payload.client.device } : {}),
        ...(payload.client.embedOrigin !== undefined ? { embedOrigin: payload.client.embedOrigin } : {}),
      },
    };
    // One key per attempt: the same request (a retry after a lost answer or a refused try) keeps its key, so the server
    // returns the first answer instead of counting twice; other answers are another submission and get another key.
    const request = JSON.stringify(body);
    if (attempt.current?.request !== request) attempt.current = { request, key: uuidv7() };
    const outcome = await submitPublicForm(page.slug, body, attempt.current.key, token.current);
    switch (outcome.kind) {
      case 'ok': {
        attempt.current = null;
        // Only the held status this page can say is acted on; the renderer's own ending (thanks, redirect) still shows.
        const held = outcome.held === 'pending_review';
        setUnderReview(held);
        // The reference numbers the server issued (only those the ending shows) replace the previews on the ending.
        return {
          ok: true,
          submissionId: outcome.submissionId as SubmissionId,
          endingId: outcome.endingId as EndingId,
          ...(held ? { held: 'pending_review' as const } : {}),
          ...(outcome.uniqueId !== undefined ? { uniqueId: outcome.uniqueId } : {}),
          ...(outcome.uniqueIds !== undefined ? { uniqueIds: outcome.uniqueIds } : {}),
        };
      }
      case 'invalid':
        // The server re-checks every answer against the live version: show what it refused next to the fields.
        return { ok: false, kind: 'invalid', status: 422, errors: fieldErrors(outcome.errors, version.definition) };
      case 'version_superseded':
        // Nothing was stored. The respondent chooses when to load the new version; their answers wait in memory.
        setSuperseded({ answers: payload.answers, from: version.definition });
        return { ok: false, kind: 'version_superseded' };
      case 'closed':
        return { ok: false, kind: 'closed' };
      case 'limit_reached':
        return { ok: false, kind: 'limit_reached' };
      case 'rate_limited':
        return { ok: false, kind: 'rate_limited' };
      case 'password_required':
        // The token ended: the page asks for the password again.
        token.current = null;
        reload();
        throw new Error('This form needs its password.');
      case 'missing':
        reload();
        throw new Error('This form is not published.');
      case 'key_reused':
        attempt.current = null;
        throw new Error('This submission could not be matched with its earlier try.');
    }
  };

  return (
    <main className="fr-fill min-h-svh">
      {superseded ? (
        <div className="mx-auto max-w-[640px] px-6 pt-6">
          <Alert variant="warning" icon role="alert">
            <AlertDescription className="space-y-2">
              <p className="font-medium">{t(M['fill.superseded'])}</p>
              <p>{t(M['fill.superseded_hint'])}</p>
              <Button type="button" size="sm" onClick={() => void reloadWithAnswers()}>
                {t(M['fill.superseded_reload'])}
              </Button>
              {reloadFailed ? <p className="text-destructive">{t(M['fill.reload_failed'])}</p> : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {underReview ? (
        <div className="mx-auto max-w-[640px] px-6 pt-6">
          <Alert variant="info" icon role="status">
            <AlertTitle>{t(M['fill.under_review'])}</AlertTitle>
            <AlertDescription>{t(M['fill.under_review_hint'])}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {unlockError ? (
        <p role="alert" className="mx-auto max-w-[640px] px-6 pt-6 text-[14px] text-destructive">
          {t(unlockError === 'wrong' ? M['fill.password_wrong'] : unlockError === 'rate_limited' ? M['fill.password_rate_limited'] : M['fill.password_failed'])}
        </p>
      ) : null}
      <FormRenderer
        key={`${shown.versionId}:${page.generation}`}
        version={shown}
        mode="live"
        status={status}
        locale={locale}
        uploader={uploader}
        session={session}
        {...(page.answers ? { initialAnswers: page.answers } : {})}
        onSubmit={submit}
        onEvent={(event) => {
          // "Submit another response" starts a new form: the notice was about the one before.
          if (event.type === 'restart') setUnderReview(false);
        }}
        onUnlock={(password) => void unlock(password)}
      />
    </main>
  );
}
