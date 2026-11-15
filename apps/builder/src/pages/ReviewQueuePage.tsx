import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck } from 'lucide-react';
import { Badge, Button } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { useActiveOrg } from '@/auth/client';
import { describeFailure, isInvalidCursor } from '@/components/responses/errors';
import { formatWhen } from '@/components/responses/format';
import { ageText } from '@/components/review/age';
import { responseLink } from '@/components/review/links';
import { QUEUE_AGES, getReviewQueue, type QueueAge, type QueueFilters, type QueueItem } from '@/persistence/reviewsApi';

const M = defineMessages('builder', {
  'review_queue.title': 'Review queue',
  'review_queue.back': 'Back to forms',
  'review_queue.intro': 'The review units that wait for you, newest response first. Open one to read the answers and decide.',
  'review_queue.loading': 'Loading the queue…',
  'review_queue.load_failed': 'The review queue could not be loaded.',
  'review_queue.retry': 'Try again',
  'review_queue.empty': 'Nothing is waiting for your review.',
  'review_queue.empty_filtered': 'Nothing waiting matches these filters.',
  'review_queue.filter_form': 'Form',
  'review_queue.filter_form_all': 'All forms',
  'review_queue.filter_unit': 'Unit',
  'review_queue.filter_unit_all': 'All units',
  'review_queue.filter_age': 'Waiting for',
  'review_queue.filter_age_all': 'Any time',
  'review_queue.age_1d': 'At least 1 day',
  'review_queue.age_3d': 'At least 3 days',
  'review_queue.age_7d': 'At least 7 days',
  'review_queue.age_30d': 'At least 30 days',
  'review_queue.filter_clear': 'Clear filters',
  'review_queue.list': 'Units waiting for your review',
  'review_queue.item': '{unit} · {form}',
  'review_queue.waiting': 'Waiting {age}',
  'review_queue.received': 'Received {when}',
  'review_queue.required': 'Required',
  'review_queue.optional': 'Optional',
  'review_queue.round': 'Round {n}',
  'review_queue.more': 'Show more',
  'review_queue.more_loading': 'Loading…',
  'review_queue.more_failed': 'More could not be loaded.',
});

const AGE_TEXT: Record<QueueAge, MessageId> = {
  '1d': M['review_queue.age_1d'],
  '3d': M['review_queue.age_3d'],
  '7d': M['review_queue.age_7d'],
  '30d': M['review_queue.age_30d'],
};

const CONTROL = 'h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground';

const keyOf = (item: Pick<QueueItem, 'submissionId' | 'unitId'>) => `${item.submissionId}:${item.unitId}`;

interface Filters {
  formId: string;
  unitId: string;
  age: QueueAge | '';
}

const NO_FILTERS: Filters = { formId: '', unitId: '', age: '' };

/** What goes on the wire: only the filters that are set. */
const asked = (f: Filters): QueueFilters => ({ formId: f.formId || undefined, unitId: f.unitId || undefined, age: f.age || undefined });

type Loaded = { phase: 'loading' } | { phase: 'failed'; text: string } | { phase: 'ready'; items: QueueItem[]; next: string | null; moreFailed: boolean };

/**
 * `/reviews`: the review units that wait for the signed-in member (WP-2.33), newest response first, with filters for the
 * form, the unit and how long they have waited. A row names the form, the unit and its age and never an answer; it opens
 * the response, where the member reads it and decides. The API lists only what the member may decide now (their group,
 * nothing earlier still open, nothing barred by the four-eyes rule), so an empty queue is an empty queue.
 */
export function ReviewQueuePage() {
  const org = useActiveOrg()?.id ?? null;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Every form and unit the queue has shown, so the pickers keep offering them after a filter narrows the list. */
  const [forms, setForms] = useState<ReadonlyMap<string, string>>(new Map());
  const [units, setUnits] = useState<ReadonlyMap<string, { name: string; formId: string }>>(new Map());

  const learn = useCallback((items: readonly QueueItem[]) => {
    setForms((now) => new Map([...now, ...items.map((i) => [i.formId, i.formTitle] as const)]));
    setUnits((now) => new Map([...now, ...items.map((i) => [i.unitId, { name: i.unitName, formId: i.formId }] as const)]));
  }, []);

  /** Back to a first page that has not arrived yet: a filter changed, or the member asked again. */
  function restart(next: Filters) {
    setFilters(next);
    setLoaded({ phase: 'loading' });
    setLoadingMore(false);
    setAttempt((n) => n + 1);
  }

  // The first page, again whenever a filter changes or a retry is asked for. An answer for an older request is dropped.
  useEffect(() => {
    if (org === null) return;
    let live = true;
    getReviewQueue(org, asked(filters)).then(
      (page) => {
        if (!live) return;
        learn(page.items);
        setLoaded({ phase: 'ready', items: page.items, next: page.nextCursor, moreFailed: false });
      },
      (failure: unknown) => live && setLoaded({ phase: 'failed', text: describeFailure(failure, M['review_queue.load_failed']) }),
    );
    return () => {
      live = false;
    };
  }, [org, filters, attempt, learn]);

  async function more() {
    if (org === null || loaded.phase !== 'ready' || loaded.next === null || loadingMore) return;
    const cursor = loaded.next;
    setLoadingMore(true);
    try {
      const page = await getReviewQueue(org, asked(filters), cursor);
      learn(page.items);
      setLoaded((now) => {
        if (now.phase !== 'ready' || now.next !== cursor) return now;
        const have = new Set(now.items.map(keyOf));
        return { phase: 'ready', items: [...now.items, ...page.items.filter((i) => !have.has(keyOf(i)))], next: page.nextCursor, moreFailed: false };
      });
    } catch (failure) {
      // A cursor the API no longer accepts cannot be retried: the list starts again from the top.
      if (isInvalidCursor(failure)) restart(filters);
      else setLoaded((now) => (now.phase === 'ready' ? { ...now, moreFailed: true } : now));
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = filters.formId !== '' || filters.unitId !== '' || filters.age !== '';
  const unitOptions = [...units].filter(([, u]) => filters.formId === '' || u.formId === filters.formId);

  let body;
  if (loaded.phase === 'loading') {
    body = (
      <p role="status" className="py-10 text-center text-[14px] text-muted-foreground">
        {t(M['review_queue.loading'])}
      </p>
    );
  } else if (loaded.phase === 'failed') {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-[14px] text-destructive">{loaded.text}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => restart(filters)}>
          {t(M['review_queue.retry'])}
        </Button>
      </div>
    );
  } else if (loaded.items.length === 0) {
    body = (
      <div className="mx-auto mt-10 flex max-w-[400px] flex-col items-center rounded-[12px] border border-dashed border-border bg-surface-subtle px-6 py-12 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
          <ClipboardCheck className="size-5" />
        </span>
        <p className="mt-4 text-[15px] leading-6 text-muted-foreground">{t(filtered ? M['review_queue.empty_filtered'] : M['review_queue.empty'])}</p>
      </div>
    );
  } else {
    body = (
      <>
        <ul aria-label={t(M['review_queue.list'])} className="divide-y divide-border rounded-[12px] border border-border">
          {loaded.items.map((item) => (
            <li key={keyOf(item)} className="flex flex-col gap-1 px-4 py-3">
              <Link to={responseLink(item)} className="text-[15px] font-semibold hover:underline">
                {t(M['review_queue.item'], { unit: item.unitName, form: item.formTitle })}
              </Link>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                <span>{t(M['review_queue.waiting'], { age: ageText(item.ageSeconds) })}</span>
                <span>{t(M['review_queue.received'], { when: formatWhen(item.receivedAt) })}</span>
                <Badge variant="secondary" size="sm">
                  {t(item.required ? M['review_queue.required'] : M['review_queue.optional'])}
                </Badge>
                {item.round > 1 ? <span>{t(M['review_queue.round'], { n: item.round })}</span> : null}
              </p>
            </li>
          ))}
        </ul>
        {loaded.moreFailed ? (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {t(M['review_queue.more_failed'])}
          </p>
        ) : null}
        {loaded.next !== null ? (
          <div className="mt-4 flex justify-center">
            <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void more()}>
              {t(loadingMore ? M['review_queue.more_loading'] : M['review_queue.more'])}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[960px] px-8 pb-24 pt-8 text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
        <Link to="/forms">
          <ArrowLeft />
          {t(M['review_queue.back'])}
        </Link>
      </Button>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['review_queue.title'])}</h1>
      <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{t(M['review_queue.intro'])}</p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <select
          aria-label={t(M['review_queue.filter_form'])}
          className={CONTROL}
          value={filters.formId}
          // The units of another form are not offered, so a unit picked for the old form does not stay picked.
          onChange={(e) => restart({ ...filters, formId: e.target.value, unitId: '' })}
        >
          <option value="">{t(M['review_queue.filter_form_all'])}</option>
          {[...forms].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <select aria-label={t(M['review_queue.filter_unit'])} className={CONTROL} value={filters.unitId} onChange={(e) => restart({ ...filters, unitId: e.target.value })}>
          <option value="">{t(M['review_queue.filter_unit_all'])}</option>
          {unitOptions.map(([id, unit]) => (
            <option key={id} value={id}>
              {unit.name}
            </option>
          ))}
        </select>
        <select aria-label={t(M['review_queue.filter_age'])} className={CONTROL} value={filters.age} onChange={(e) => restart({ ...filters, age: e.target.value as QueueAge | '' })}>
          <option value="">{t(M['review_queue.filter_age_all'])}</option>
          {QUEUE_AGES.map((age) => (
            <option key={age} value={age}>
              {t(AGE_TEXT[age])}
            </option>
          ))}
        </select>
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => restart(NO_FILTERS)}>
            {t(M['review_queue.filter_clear'])}
          </Button>
        ) : null}
      </div>

      <div className="mt-6">{body}</div>
    </main>
  );
}
