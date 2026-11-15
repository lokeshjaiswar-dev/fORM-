import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Lock, Star, X } from 'lucide-react';
import { Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { getSubmission, patchSubmission, type SubmissionDetail } from '@/persistence/submissionsApi';
import type { ReviewDetail } from '@/persistence/reviewsApi';
import { describeFailure } from '@/components/responses/errors';
import { formatWhen, statusLabel, versionLabel } from '@/components/responses/format';
import { StoredFile } from '@/components/responses/StoredFile';
import { UnitDecisionPanel } from '@/components/review/UnitDecisionPanel';

const M = defineMessages('builder', {
  'responses.detail.label': 'Response',
  'responses.detail.close': 'Close response',
  'responses.detail.previous': 'Previous response',
  'responses.detail.next': 'Next response',
  'responses.detail.received': 'Received {when}',
  'responses.detail.in_trash': 'This response is in the trash.',
  'responses.detail.archived': 'This response is archived.',
  'responses.detail.star': 'Star this response',
  'responses.detail.mark_unread': 'Mark as unread',
  'responses.detail.loading': 'Loading the response…',
  'responses.detail.load_failed': 'This response could not be loaded.',
  'responses.detail.flag_failed': 'The change could not be saved.',
  'responses.detail.no_answer': 'No answer',
  'responses.detail.hidden': 'Hidden: this answer is protected',
  'responses.detail.files': 'Files',
  'responses.detail.answers': 'Answers',
  'responses.detail.empty': 'This response has no answers.',
});

type Flags = { read?: boolean; starred?: boolean };

export interface DetailPaneProps {
  formId: string;
  /** The response shown; the pane starts over when it changes (the previous and next buttons keep their focus). */
  id: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  /** Tells the grid a flag changed, so its row follows without asking the API for the page again. */
  onFlags: (id: string, change: Flags) => void;
  /** Tells the grid a decision settled the response (`complete` or `rejected`), so its row shows the new status without asking for the page again. */
  onStatus?: (id: string, status: string) => void;
}

type Loaded = { phase: 'loading' } | { phase: 'failed'; text: string } | { phase: 'ready'; detail: SubmissionDetail };

/**
 * One response as an inbox reader: its answers as the server built them (protected ones hidden), the files it holds,
 * and what the member can change on it: star it, or mark it unread. Opening a response marks it read (`PATCH read=true`
 * once the response has loaded and the API says it is unread), the way an inbox does.
 *
 * A response that was held for review (WP-2.33) also shows its review units and, for a checker, the decision buttons
 * (`UnitDecisionPanel`). Its answers are then the ones of the review read, whose token a decision names, so a checker
 * decides on what they are looking at; they are the same answers, redacted by the same server rule, as the plain read.
 */
export function DetailPane({ formId, id, hasPrevious, hasNext, onPrevious, onNext, onClose, onFlags, onStatus }: DetailPaneProps) {
  // What arrived is kept with the response it is for: moving to the next response shows "loading" until its own answer is in.
  const [held, setHeld] = useState<{ id: string; loaded: Loaded } | null>(null);
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState<{ id: string; text: string } | null>(null);
  /** The review of the response shown, as the panel last read it; null when there is none (not under review, still loading, or it failed). */
  const [review, setReview] = useState<{ id: string; detail: ReviewDetail | null } | null>(null);
  /** Moves on when the answers a checker read are out of date, so the plain read is made again too. */
  const [reads, setReads] = useState(0);
  const flagged = useRef(onFlags);
  const root = useRef<HTMLElement>(null);
  const loaded: Loaded = held?.id === id ? held.loaded : { phase: 'loading' };
  const problem = trouble?.id === id ? trouble.text : null;
  const reviewed = review?.id === id ? review.detail : null;

  useEffect(() => {
    flagged.current = onFlags;
  });

  // A pane that opens takes the keyboard, so a keyboard user who opened a response from the grid is in it.
  useEffect(() => {
    root.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    getSubmission(formId, id).then(
      async (detail) => {
        if (!live) return;
        setHeld({ id, loaded: { phase: 'ready', detail } });
        if (detail.read) return;
        try {
          const flags = await patchSubmission(formId, id, { read: true });
          // The grid row follows even when the member has moved on; the pane only when it still shows this response.
          flagged.current(id, { read: flags.read, starred: flags.starred });
          if (live) setHeld({ id, loaded: { phase: 'ready', detail: { ...detail, read: flags.read, starred: flags.starred } } });
        } catch {
          // The response is on screen either way; it stays unread in the list until the member marks it.
        }
      },
      (failure: unknown) => {
        if (live) setHeld({ id, loaded: { phase: 'failed', text: describeFailure(failure, M['responses.detail.load_failed']) } });
      },
    );
    return () => {
      live = false;
    };
  }, [formId, id, reads]);

  async function change(next: Flags) {
    setSaving(true);
    setTrouble(null);
    try {
      const flags = await patchSubmission(formId, id, next);
      onFlags(id, { read: flags.read, starred: flags.starred });
      setHeld((now) =>
        now?.id === id && now.loaded.phase === 'ready' ? { id, loaded: { phase: 'ready', detail: { ...now.loaded.detail, read: flags.read, starred: flags.starred } } } : now,
      );
    } catch (failure) {
      setTrouble({ id, text: describeFailure(failure, M['responses.detail.flag_failed']) });
    } finally {
      setSaving(false);
    }
  }

  const detail = loaded.phase === 'ready' ? loaded.detail : null;
  // A response is under review when the API says it was held for it, or its status says so (it is the only way to be pending_review or rejected).
  const underReview = detail !== null && (detail.review !== undefined || detail.status === 'pending_review' || detail.status === 'rejected');
  // The answers of the review read when there is one: its token is what a decision names.
  const fields = reviewed?.fields ?? detail?.fields ?? [];
  const files = reviewed?.files ?? detail?.files ?? [];

  function settled(status: string) {
    setHeld((now) => (now?.id === id && now.loaded.phase === 'ready' ? { id, loaded: { phase: 'ready', detail: { ...now.loaded.detail, status } } } : now));
    onStatus?.(id, status);
  }

  return (
    <aside ref={root} tabIndex={-1} aria-label={t(M['responses.detail.label'])} className="flex min-h-0 flex-col overflow-y-auto bg-background outline-none lg:rounded-[12px] lg:border lg:border-border">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-2">
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['responses.detail.previous'])} disabled={!hasPrevious} onClick={onPrevious}>
            <ChevronUp />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['responses.detail.next'])} disabled={!hasNext} onClick={onNext}>
            <ChevronDown />
          </Button>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['responses.detail.close'])} onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="px-4 pb-6 pt-4">
        {loaded.phase === 'loading' ? (
          <p role="status" className="text-[14px] text-muted-foreground">
            {t(M['responses.detail.loading'])}
          </p>
        ) : null}
        {loaded.phase === 'failed' ? (
          <p role="alert" className="text-[14px] text-destructive">
            {loaded.text}
          </p>
        ) : null}
        {detail ? (
          <>
            <h2 className="text-[18px] font-semibold leading-snug">
              {t(M['responses.detail.received'], { when: formatWhen(detail.receivedAt) })}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {[statusLabel(detail.status), versionLabel(detail.versionNumber), detail.locale].join(' · ')}
            </p>
            {detail.trashedAt ? <p className="mt-2 text-[13px] text-destructive">{t(M['responses.detail.in_trash'])}</p> : detail.archivedAt ? <p className="mt-2 text-[13px] text-muted-foreground">{t(M['responses.detail.archived'])}</p> : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" pressed={detail.starred} disabled={saving} onClick={() => void change({ starred: !detail.starred })}>
                <Star className={cn(detail.starred && 'fill-current')} />
                {t(M['responses.detail.star'])}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={saving || !detail.read} onClick={() => void change({ read: false })}>
                {t(M['responses.detail.mark_unread'])}
              </Button>
            </div>
            {problem ? (
              <p role="alert" className="mt-2 text-[13px] text-destructive">
                {problem}
              </p>
            ) : null}

            {underReview ? (
              <UnitDecisionPanel
                key={id}
                formId={formId}
                id={id}
                onDetail={(read) => setReview({ id, detail: read })}
                onSettled={settled}
                onStale={() => setReads((n) => n + 1)}
              />
            ) : null}

            <h3 className="mt-6 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['responses.detail.answers'])}</h3>
            {fields.length === 0 ? <p className="mt-2 text-[14px] text-muted-foreground">{t(M['responses.detail.empty'])}</p> : null}
            <dl className="mt-2">
              {fields.map((field, index) => (
                <div key={field.id} className={index === 0 ? 'pb-3' : 'border-t border-border py-3'}>
                  <dt className="text-[12px] font-medium text-muted-foreground">{field.label || field.key}</dt>
                  <dd className="mt-1 text-[15px] leading-6">
                    {field.masked ? (
                      <span className="flex items-center gap-1.5 text-muted-foreground" title={t(M['responses.detail.hidden'])}>
                        <Lock role="img" aria-label={t(M['responses.detail.hidden'])} className="size-3.5 shrink-0" />
                        {field.value}
                      </span>
                    ) : field.value ? (
                      <span className="whitespace-pre-wrap break-words">{field.value}</span>
                    ) : (
                      <span className="text-muted-foreground">{t(M['responses.detail.no_answer'])}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>

            {files.length > 0 ? (
              <>
                <h3 className="mt-6 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['responses.detail.files'])}</h3>
                <ul className="mt-2 space-y-3">
                  {files.map((file, index) => (
                    <li key={file.id ?? `${file.blockId}-${index}`}>
                      <StoredFile formId={formId} file={file} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
