import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { Alert, AlertDescription, Badge, Button, type BadgeVariant } from '@dmacq/ui';
import { BUILDER_LOCALE, t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { EVENT_LABELS, STATUS_LABELS, W, describeWebhookFailure, isForbidden } from '@/components/settings/webhookText';
import { DELIVERY_STATUSES, listDeliveries, replayDelivery, type Delivery, type DeliveryStatus } from '@/persistence/webhooksApi';

const M = defineMessages('builder', {
  'webhooks.log.title': 'Delivery log',
  'webhooks.log.intro': 'Each time a response is sent to this address. The status and timing are kept for a year; the start of the receiver’s answer for 30 days.',
  'webhooks.log.refresh': 'Refresh',
  'webhooks.log.filter': 'Show',
  'webhooks.log.filter_all': 'Every delivery',
  'webhooks.log.loading': 'Loading the delivery log…',
  'webhooks.log.empty': 'Nothing has been sent to this address yet.',
  'webhooks.log.empty_filtered': 'No delivery has this status.',
  'webhooks.log.more': 'Show older deliveries',
  'webhooks.log.table': 'Deliveries of this webhook, newest first',
  'webhooks.log.col_when': 'When',
  'webhooks.log.col_event': 'Event',
  'webhooks.log.col_status': 'Status',
  'webhooks.log.col_http': 'Receiver’s answer',
  'webhooks.log.col_try': 'Try',
  'webhooks.log.col_action': 'Action',
  'webhooks.log.http': 'HTTP {status}',
  'webhooks.log.no_answer': 'No answer',
  'webhooks.log.took': '{ms} ms',
  'webhooks.log.next_try': 'Next try {when}',
  'webhooks.log.is_replay': 'A replay of an earlier delivery',
  'webhooks.log.replay': 'Replay',
  'webhooks.log.replay_label': 'Replay the delivery of “{event}” from {when}',
  'webhooks.log.replaying': 'Sending…',
  'webhooks.log.replayed': 'Queued to send again. It is the newest row below.',
  'webhooks.log.replay_off': 'Switch the webhook on to send a delivery again.',
  'webhooks.log.replay_failed': 'The delivery could not be queued again. Try once more.',
  'webhooks.log.load_failed': 'The delivery log could not be loaded.',
  'webhooks.log.retry': 'Try again',
});

/** Rows asked for at a time. */
const PAGE = 50;

const STATUS_TONE: Readonly<Record<DeliveryStatus, BadgeVariant>> = {
  pending: 'secondary',
  retrying: 'warning',
  succeeded: 'success',
  failed: 'danger',
  dead: 'danger',
};

const when = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'medium' });
const stamp = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : when.format(date);
};

type Load = { status: 'loading' } | { status: 'failed'; text: string } | { status: 'forbidden' } | { status: 'ready' };

export interface WebhookDeliveriesPanelProps {
  formId: string;
  webhookId: string;
  /** Whether the webhook is switched on. A switched-off webhook cannot send a delivery again (the API answers 409), so Replay is off for it. */
  enabled?: boolean;
}

/**
 * The delivery log of one webhook with a Replay button on every row (WP-1.18). Newest first, a page at a time, with a filter
 * on the status. Replay asks the API to send the same event again; the API adds a new delivery and queues it, and this panel
 * reads the log again so the new row shows. Nothing here polls: Refresh shows what has happened since. A role without
 * `data.route` gets the same "you need the data routing permission" state as the tab.
 */
export function WebhookDeliveriesPanel({ formId, webhookId, enabled = true }: WebhookDeliveriesPanelProps) {
  const org = useActiveOrg()?.id ?? null;
  const [filter, setFilter] = useState<DeliveryStatus | ''>('');
  const [rows, setRows] = useState<Delivery[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [more, setMore] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'destructive'; text: string } | null>(null);
  // The newest read wins: a slow answer to an older request (another filter, an earlier refresh) is dropped.
  const generation = useRef(0);

  const fail = useCallback((err: unknown): Load => (isForbidden(err) ? { status: 'forbidden' } : { status: 'failed', text: describeWebhookFailure(err, M['webhooks.log.load_failed']) }), []);

  /** The first page, from the top: on opening, on Refresh, after a replay, and when the filter changes. */
  const refresh = useCallback((): Promise<void> => {
    if (org === null) return Promise.resolve();
    const mine = ++generation.current;
    return listDeliveries(org, formId, webhookId, { limit: PAGE, ...(filter ? { status: filter } : {}) }).then(
      (page) => {
        if (mine !== generation.current) return;
        setRows(page.items);
        setNext(page.nextCursor);
        setLoad({ status: 'ready' });
      },
      (err: unknown) => {
        if (mine !== generation.current) return;
        setLoad(fail(err));
      },
    );
  }, [org, formId, webhookId, filter, fail]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  async function older() {
    if (org === null || next === null || more) return;
    const mine = generation.current;
    setMore(true);
    try {
      const page = await listDeliveries(org, formId, webhookId, { limit: PAGE, cursor: next, ...(filter ? { status: filter } : {}) });
      if (mine !== generation.current) return;
      // A replay made while this page was loading can shift rows; each delivery is listed once.
      setRows((current) => [...current, ...page.items.filter((row) => !current.some((c) => c.id === row.id))]);
      setNext(page.nextCursor);
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof ApiProblem && err.code === 'INVALID_CURSOR') await refresh();
      else setLoad(fail(err));
    } finally {
      setMore(false);
    }
  }

  async function replay(delivery: Delivery) {
    if (org === null || replaying !== null) return;
    setReplaying(delivery.id);
    setNotice(null);
    try {
      await replayDelivery(org, formId, webhookId, delivery.id);
      setNotice({ tone: 'info', text: t(M['webhooks.log.replayed']) });
      await refresh();
    } catch (err) {
      if (isForbidden(err)) setLoad({ status: 'forbidden' });
      else if (err instanceof ApiProblem && err.code === 'WEBHOOK_DISABLED') setNotice({ tone: 'destructive', text: t(M['webhooks.log.replay_off']) });
      else setNotice({ tone: 'destructive', text: describeWebhookFailure(err, M['webhooks.log.replay_failed']) });
    } finally {
      setReplaying(null);
    }
  }

  if (load.status === 'forbidden') return <MissingPermission />;

  return (
    <section aria-label={t(M['webhooks.log.title'])} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h4 className="text-[15px] font-semibold">{t(M['webhooks.log.title'])}</h4>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t(M['webhooks.log.intro'])}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {t(M['webhooks.log.filter'])}
            <select
              className="h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground"
              value={filter}
              onChange={(event) => {
                setLoad({ status: 'loading' });
                setFilter(event.target.value === '' ? '' : (event.target.value as DeliveryStatus));
              }}
            >
              <option value="">{t(M['webhooks.log.filter_all'])}</option>
              {DELIVERY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(STATUS_LABELS[status])}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw />
            {t(M['webhooks.log.refresh'])}
          </Button>
        </div>
      </div>

      {!enabled ? <p className="text-[13px] text-muted-foreground">{t(M['webhooks.log.replay_off'])}</p> : null}
      {notice ? (
        <Alert variant={notice.tone === 'info' ? 'info' : 'destructive'} icon>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      {load.status === 'loading' ? <p className="text-[13px] text-muted-foreground">{t(M['webhooks.log.loading'])}</p> : null}
      {load.status === 'failed' ? (
        <Alert variant="destructive" icon>
          <AlertDescription>
            <span className="block">{load.text}</span>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => void refresh()}>
              {t(M['webhooks.log.retry'])}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {load.status === 'ready' && rows.length === 0 ? <p className="text-[13px] text-muted-foreground">{t(M[filter ? 'webhooks.log.empty_filtered' : 'webhooks.log.empty'])}</p> : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]" aria-label={t(M['webhooks.log.table'])}>
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t(M['webhooks.log.col_when'])}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t(M['webhooks.log.col_event'])}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t(M['webhooks.log.col_status'])}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t(M['webhooks.log.col_http'])}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t(M['webhooks.log.col_try'])}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t(M['webhooks.log.col_action'])}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <DeliveryRow key={row.id} row={row} busy={replaying === row.id} locked={replaying !== null || !enabled} onReplay={() => void replay(row)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {next !== null ? (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={more} onClick={() => void older()}>
            {t(M['webhooks.log.more'])}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function DeliveryRow({ row, busy, locked, onReplay }: { row: Delivery; busy: boolean; locked: boolean; onReplay: () => void }) {
  const at = stamp(row.createdAt);
  return (
    <tr className="border-t border-border align-top">
      <td className="whitespace-nowrap px-3 py-2">
        {at}
        {row.replayOf ? <span className="block text-[12px] text-muted-foreground">{t(M['webhooks.log.is_replay'])}</span> : null}
      </td>
      <td className="px-3 py-2">{t(EVENT_LABELS[row.event])}</td>
      <td className="px-3 py-2">
        <Badge variant={STATUS_TONE[row.status]}>{t(STATUS_LABELS[row.status])}</Badge>
        {row.nextAttemptAt && (row.status === 'retrying' || row.status === 'pending') ? (
          <span className="mt-1 block text-[12px] text-muted-foreground">{t(M['webhooks.log.next_try'], { when: stamp(row.nextAttemptAt) })}</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {row.httpStatus !== null ? t(M['webhooks.log.http'], { status: row.httpStatus }) : row.attempt > 0 ? t(M['webhooks.log.no_answer']) : '–'}
        {row.durationMs !== null ? <span className="ml-1.5 text-muted-foreground">{t(M['webhooks.log.took'], { ms: row.durationMs })}</span> : null}
        {row.responseSnippet ? <code className="mt-1 block max-w-[320px] break-words rounded bg-muted px-1.5 py-1 text-[12px] text-foreground [overflow-wrap:anywhere]">{row.responseSnippet}</code> : null}
      </td>
      <td className="px-3 py-2">{row.attempt}</td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked}
          aria-label={t(M['webhooks.log.replay_label'], { event: t(EVENT_LABELS[row.event]), when: at })}
          onClick={onReplay}
        >
          {busy ? t(M['webhooks.log.replaying']) : t(M['webhooks.log.replay'])}
        </Button>
      </td>
    </tr>
  );
}

/** What a role without `data.route` sees in place of a webhook screen. Shared with the Webhooks tab through the same words. */
export function MissingPermission() {
  return (
    <Alert variant="warning" icon role="alert">
      <AlertDescription>
        <span className="block font-medium">{t(W['webhooks.no_permission.title'])}</span>
        <span className="mt-1 block">{t(W['webhooks.no_permission.body'])}</span>
      </AlertDescription>
    </Alert>
  );
}
