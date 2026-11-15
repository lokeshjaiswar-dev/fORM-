import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge, Button } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useActiveOrg } from '@/auth/client';
import { describeFailure } from '@/components/responses/errors';
import { formatWhen } from '@/components/responses/format';
import { STATE_TONE, decisionFailure, fourEyesText, reasonLabel, reasonOptions, unitStateLabel, type DecisionFailure } from '@/components/review/labels';
import { createDecider, getReviewDetail, type Decided, type ReasonCode, type ReviewDecisionRow, type ReviewDetail, type ReviewUnit } from '@/persistence/reviewsApi';

const M = defineMessages('builder', {
  'review_panel.title': 'Review',
  'review_panel.loading': 'Loading the review…',
  'review_panel.load_failed': 'The review could not be loaded.',
  'review_panel.retry': 'Try again',
  'review_panel.redacted': 'You see only the answers of the units you check, and the parts of the form that no unit covers.',
  'review_panel.units': 'Review units',
  'review_panel.none': 'This response has no review units.',
  'review_panel.required': 'Required',
  'review_panel.optional': 'Optional',
  'review_panel.group': 'Checked by {group}',
  'review_panel.round': 'Round {n}',
  'review_panel.blocked': 'This unit waits until the earlier steps are approved.',
  'review_panel.history': 'History of {unit}',
  'review_panel.history_approved': 'Approved by {who}, {when}',
  'review_panel.history_rejected': 'Rejected by {who}, {when}',
  'review_panel.history_rejected_reason': 'Rejected by {who}, {when}: {reason}',
  'review_panel.a_checker': 'a checker',
  'review_panel.reason': 'Reason for rejecting {unit}',
  'review_panel.reason_placeholder': 'Reason (needed to reject)',
  'review_panel.approve': 'Approve',
  'review_panel.reject': 'Reject',
  'review_panel.approve_unit': 'Approve {unit}',
  'review_panel.reject_unit': 'Reject {unit}',
  'review_panel.saving': 'Saving your decision…',
  'review_panel.done_approved': '{unit} is approved.',
  'review_panel.done_rejected': '{unit} is rejected.',
  'review_panel.settled_complete': 'Every required unit is approved, so the response is complete.',
  'review_panel.settled_rejected': 'A required unit was rejected, so the response is rejected.',
});

/** Where a response ends once a decision settles it. */
const SETTLED = new Set(['complete', 'rejected']);

export interface UnitDecisionPanelProps {
  formId: string;
  /** The response under review; the panel is keyed by it, so a different response starts over. */
  id: string;
  /**
   * The review as it was last read, or null while there is none (loading, failed). The pane shows the answers of this read
   * and no other: the token a decision names is the one of these answers, so the member decides on what they are looking at.
   */
  onDetail: (detail: ReviewDetail | null) => void;
  /** A decision settled the response (`complete` or `rejected`): the pane and the grid show its new status. */
  onSettled: (status: string) => void;
  /** The unit's answers changed after the member read them (409): the pane reads the response again too. */
  onStale: () => void;
}

type Loaded = { phase: 'loading' } | { phase: 'failed'; text: string } | { phase: 'ready'; detail: ReviewDetail };

/** What the member was last told about a unit: a decision made or a refusal, kept across the reload that follows either. */
type Notice = { unitId: string; kind: 'done' | 'error'; text: string; barred: boolean };

/**
 * The checker's side of a held response (WP-2.33): each review unit with where it stands, whether it is required, who checks
 * it and what has been decided on it so far, and, for a unit the member may decide now, Approve and Reject (a reason from
 * the fixed catalogue is needed to reject). The answers are the server's, redacted for the member's own units.
 *
 * A decision names the token of the answers as the member read them (`answersHash`) and carries an `Idempotency-Key` made
 * for that click and sent again on a retry (`createDecider`). A refusal is told in plain words; a stale one (409
 * `REVIEW_STALE`: the answers changed since they were read), a unit already decided and an earlier step still open each
 * read the response again, and a refusal that will not change (four-eyes, not in the group) takes the buttons away.
 */
export function UnitDecisionPanel({ formId, id, onDetail, onSettled, onStale }: UnitDecisionPanelProps) {
  const org = useActiveOrg()?.id ?? null;
  const headingId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [reasons, setReasons] = useState<Readonly<Record<string, ReasonCode | ''>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [decider] = useState(createDecider);
  const callbacks = useRef({ onDetail, onSettled, onStale });
  /** A read of the review has arrived: a later one that fails leaves it on screen (and the pane on its answers) instead of taking it away. */
  const read = useRef(false);
  useEffect(() => {
    callbacks.current = { onDetail, onSettled, onStale };
  });

  // The review, asked for again whenever `reloads` moves on (a retry, a decision, a stale answer). What is on screen stays
  // until the new read arrives, so the units do not flash away.
  useEffect(() => {
    if (org === null) return;
    let live = true;
    getReviewDetail(org, formId, id).then(
      (detail) => {
        if (!live) return;
        read.current = true;
        setLoaded({ phase: 'ready', detail });
        callbacks.current.onDetail(detail);
      },
      (failure: unknown) => {
        if (!live || read.current) return;
        setLoaded({ phase: 'failed', text: describeFailure(failure, M['review_panel.load_failed']) });
        callbacks.current.onDetail(null);
      },
    );
    return () => {
      live = false;
    };
  }, [org, formId, id, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  async function decide(unit: ReviewUnit, decision: 'approve' | 'reject') {
    const reason = reasons[unit.unitId] || undefined;
    if (org === null || unit.answersHash === null || saving !== null) return;
    if (decision === 'reject' && !reason) return;
    setSaving(unit.unitId);
    setNotice(null);
    try {
      const result: Decided = await decider.decide({ org, formId, submissionId: id, unitId: unit.unitId, decision, reasonCode: reason, answersHash: unit.answersHash });
      setReasons((now) => ({ ...now, [unit.unitId]: '' }));
      setNotice({ unitId: unit.unitId, kind: 'done', text: t(result.unitState === 'approved' ? M['review_panel.done_approved'] : M['review_panel.done_rejected'], { unit: unit.name }), barred: false });
      if (SETTLED.has(result.submissionStatus)) callbacks.current.onSettled(result.submissionStatus);
      reload();
    } catch (failure) {
      const problem: DecisionFailure = decisionFailure(failure);
      setNotice({ unitId: unit.unitId, kind: 'error', text: problem.text, barred: problem.barred });
      if (problem.reload) {
        reload();
        // The answers the member read are out of date: the pane reads them again too, so they decide on what they can see.
        if (problem.code === 'REVIEW_STALE') callbacks.current.onStale();
      }
    } finally {
      setSaving(null);
    }
  }

  const detail = loaded.phase === 'ready' ? loaded.detail : null;
  const status = detail?.submission.status;

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <h3 id={headingId} className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {t(M['review_panel.title'])}
      </h3>
      {loaded.phase === 'loading' ? (
        <p role="status" className="mt-2 text-[14px] text-muted-foreground">
          {t(M['review_panel.loading'])}
        </p>
      ) : null}
      {loaded.phase === 'failed' ? (
        <div role="alert" className="mt-2 flex flex-col items-start gap-2">
          <p className="text-[14px] text-destructive">{loaded.text}</p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t(M['review_panel.retry'])}
          </Button>
        </div>
      ) : null}
      {detail ? (
        <>
          {detail.redacted ? <p className="mt-2 text-[13px] text-muted-foreground">{t(M['review_panel.redacted'])}</p> : null}
          {detail.units.length === 0 ? <p className="mt-2 text-[14px] text-muted-foreground">{t(M['review_panel.none'])}</p> : null}
          <ul aria-label={t(M['review_panel.units'])} className="mt-2 space-y-3">
            {detail.units.map((unit) => (
              <DecisionUnit
                key={unit.unitId}
                unit={unit}
                history={detail.decisions.filter((d) => d.unitId === unit.unitId)}
                reason={reasons[unit.unitId] ?? ''}
                onReason={(reason) => setReasons((now) => ({ ...now, [unit.unitId]: reason }))}
                saving={saving}
                notice={notice?.unitId === unit.unitId ? notice : null}
                onDecide={(decision) => void decide(unit, decision)}
              />
            ))}
          </ul>
          {status === 'complete' ? <p className="mt-3 text-[13px] text-muted-foreground">{t(M['review_panel.settled_complete'])}</p> : null}
          {status === 'rejected' ? <p className="mt-3 text-[13px] text-muted-foreground">{t(M['review_panel.settled_rejected'])}</p> : null}
        </>
      ) : null}
    </section>
  );
}

interface DecisionUnitProps {
  unit: ReviewUnit;
  history: readonly ReviewDecisionRow[];
  reason: ReasonCode | '';
  onReason: (reason: ReasonCode | '') => void;
  /** The unit being decided now, if any: one decision at a time. */
  saving: string | null;
  notice: Notice | null;
  onDecide: (decision: 'approve' | 'reject') => void;
}

const SELECT = 'h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground';

/** One review unit: its name and state, who checks it, what was decided on it, and the buttons when the member may decide it now. */
function DecisionUnit({ unit, history, reason, onReason, saving, notice, onDecide }: DecisionUnitProps) {
  const pending = unit.state === 'pending';
  const barred = notice?.kind === 'error' && notice.barred;
  const canDecide = unit.canDecide && unit.answersHash !== null && !barred;
  // The unit is the member's, it is open and nothing earlier holds it, yet the server does not offer it: the four-eyes rule.
  const sameEyes = pending && unit.yours && !unit.blocked && !unit.canDecide;
  const busy = saving !== null;

  return (
    <li data-unit-id={unit.unitId} className="rounded-[10px] border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[14px] font-semibold">{unit.name}</h4>
        <Badge variant={STATE_TONE[unit.state] ?? 'secondary'} size="sm">
          {unitStateLabel(unit.state)}
        </Badge>
        <span className="text-[12px] text-muted-foreground">{t(unit.required ? M['review_panel.required'] : M['review_panel.optional'])}</span>
      </div>
      {unit.groupName || unit.round > 1 ? (
        <p className="mt-1 text-[12px] text-muted-foreground">
          {[unit.groupName ? t(M['review_panel.group'], { group: unit.groupName }) : null, unit.round > 1 ? t(M['review_panel.round'], { n: unit.round }) : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {pending && unit.blocked ? <p className="mt-2 text-[13px] text-muted-foreground">{t(M['review_panel.blocked'])}</p> : null}

      {history.length > 0 ? (
        <ul aria-label={t(M['review_panel.history'], { unit: unit.name })} className="mt-2 space-y-1">
          {history.map((d) => (
            <li key={d.id} className="text-[13px] text-muted-foreground">
              {historyText(d)}
            </li>
          ))}
        </ul>
      ) : null}

      {canDecide ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label={t(M['review_panel.reason'], { unit: unit.name })} className={SELECT} value={reason} disabled={busy} onChange={(e) => onReason(e.target.value as ReasonCode | '')}>
            <option value="">{t(M['review_panel.reason_placeholder'])}</option>
            {reasonOptions().map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" aria-label={t(M['review_panel.approve_unit'], { unit: unit.name })} disabled={busy} onClick={() => onDecide('approve')}>
            {t(M['review_panel.approve'])}
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label={t(M['review_panel.reject_unit'], { unit: unit.name })} disabled={busy || reason === ''} onClick={() => onDecide('reject')}>
            {t(M['review_panel.reject'])}
          </Button>
        </div>
      ) : sameEyes && !barred ? (
        <p className="mt-2 text-[13px] text-muted-foreground">{fourEyesText()}</p>
      ) : null}

      {saving === unit.unitId ? (
        <p role="status" className="mt-2 text-[13px] text-muted-foreground">
          {t(M['review_panel.saving'])}
        </p>
      ) : null}
      {notice ? (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={notice.kind === 'error' ? 'mt-2 text-[13px] text-destructive' : 'mt-2 text-[13px] text-muted-foreground'}>
          {notice.text}
        </p>
      ) : null}
    </li>
  );
}

/** One line of a unit's history: what was decided, by whom, when, and why a reject was made. */
function historyText(d: ReviewDecisionRow): string {
  const who = d.decidedBy.name?.trim() || t(M['review_panel.a_checker']);
  const when = formatWhen(d.decidedAt);
  if (d.decision === 'approve') return t(M['review_panel.history_approved'], { who, when });
  return d.reasonCode ? t(M['review_panel.history_rejected_reason'], { who, when, reason: reasonLabel(d.reasonCode) }) : t(M['review_panel.history_rejected'], { who, when });
}
