import { useCallback, useEffect, useMemo, useState } from 'react';
import { defineMessages, type MessageId } from '@form/i18n';
import type { ReviewSettings as Settings } from '@form/schema';
import { Alert, AlertDescription, Button, Label, Switch } from '@dmacq/ui';
import { t } from '@/i18n';
import { ApiProblem, useActiveOrg } from '@/auth/client';
import { problemText } from '@/pages/auth/util';
import { listReviewGroups, type ReviewGroup } from '@/pages/org/orgApi';
import { flushAutosave } from '@/persistence/autosave';
import { ReviewConflict, ReviewInvalid, getReviewSettings, inputOf, saveReviewSettings, type ReviewView } from '@/persistence/reviewApi';
import { useDoc } from '@/state/documentStore';
import { AddUnit } from '@/components/builder/review/AddUnit';
import { UnitCard } from '@/components/builder/review/UnitCard';
import {
  assignmentOf,
  assignmentProblems,
  describeTarget,
  isChanged,
  orphansOf,
  targetOptions,
  unitBlocks,
  unitProblems,
  withAssignment,
  withoutRefusedOrphans,
} from '@/components/builder/review/reviewModel';

const M = defineMessages('builder', {
  'review.title': 'Review',
  'review.intro': 'Split the form into parts that checkers approve or reject on their own. A response counts only when every required part is approved.',
  'review.loading': 'Loading review settings…',
  'review.sign_in': 'Sign in to choose who reviews this form.',
  'review.not_saved': 'This form is not on the server yet, so groups cannot be chosen. It saves by itself a moment after you edit it.',
  'review.forbidden': 'You do not have permission to change who reviews this form.',
  'review.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'review.retry': 'Try again',
  'review.enabled': 'Review responses before they count',
  'review.enabled_hint': 'When off, a response is final as soon as it is submitted, whatever the units below say.',
  'review.distinct': 'One checker decides only one unit per response',
  'review.distinct_hint': 'Stops one person approving every part of the same response.',
  'review.units_title': 'Review units',
  'review.units_hint': 'A unit is a page, or the part from a section break to the next one. Each is checked by one group.',
  'review.units_none': 'No review units yet. Make one from a page or a section break.',
  'review.orphans': '{count, plural, one {# assignment belongs} other {# assignments belong}} to a unit that is not in this draft. {count, plural, one {It is} other {They are}} kept, because the published version may still use {count, plural, one {it} other {them}}.',
  'review.groups_denied': 'You cannot see the review groups, so you cannot give a unit to one.',
  'review.no_groups': 'There are no review groups yet. Create one on the Members page, then come back here.',
  'review.members_link': 'Open the Members page',
  'review.save': 'Save review settings',
  'review.saved': 'Review settings saved.',
  'review.refused': 'The server did not accept these settings: {detail}',
  'review.conflict': 'These settings were changed somewhere else, so yours were not saved. Reload to see the current settings, then make your changes again.',
  'review.reload': 'Reload',
  'review.reloaded': 'Reloaded. These are the settings as they are now.',
  'review.fix_first': 'Fix the problems marked above, then save.',
});

type Blocked = 'sign_in' | 'not_saved' | 'forbidden' | 'unreachable';
type Load =
  | { status: 'loading' }
  | { status: 'blocked'; reason: Blocked }
  | { status: 'ready'; view: ReviewView; /** The org's unarchived groups; null when this member may not read them. */ groups: ReviewGroup[] | null };

const BLOCKED_TEXT: Readonly<Record<Blocked, MessageId>> = {
  sign_in: M['review.sign_in'],
  not_saved: M['review.not_saved'],
  forbidden: M['review.forbidden'],
  unreachable: M['review.unreachable'],
};

/** Why the settings could not be read: the form is not on the server yet (404), the caller may not (401, 403), or the server did not answer. */
function blockedBy(err: unknown): Blocked {
  if (err instanceof ApiProblem) {
    if (err.status === 404) return 'not_saved';
    if (err.status === 401) return 'sign_in';
    if (err.status === 403) return 'forbidden';
  }
  return 'unreachable';
}

/**
 * The Review tab of the form settings (WP-2.33). Two halves with different homes. The review units (what is checked: a
 * page, or a section break up to the next one) are part of the form definition, so adding, renaming and deleting one is an
 * undoable edit saved with the draft. The assignments (which group checks a unit, in what order, whether it is required,
 * what the checker sees) are the form's live review settings on the server: they load with a revision, save in one call
 * with `If-Match`, and a stale revision offers a reload instead of overwriting someone else's save. While the form is not
 * on the server, or the settings could not be read, the units can still be edited and the assignment controls are off,
 * with the reason said.
 */
export function ReviewSettings() {
  const formId = useDoc((d) => d.formId);
  const org = useActiveOrg()?.id ?? null;
  // Another form or another org is another tab: its state starts over instead of showing the last one's.
  return <ReviewSection key={`${org ?? ''}:${formId}`} org={org} formId={formId} />;
}

function ReviewSection({ org, formId }: { org: string | null; formId: string }) {
  const def = useDoc((d) => d);
  const [state, setLoad] = useState<Load>({ status: 'loading' });
  const [form, setForm] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load: Load = org === null ? { status: 'blocked', reason: 'sign_in' } : state;

  const show = useCallback((view: ReviewView, groups: ReviewGroup[] | null) => {
    setLoad({ status: 'ready', view, groups });
    setForm(inputOf(view));
  }, []);

  /** The settings and the groups, as the server holds them now. A refusal to list the groups (403) leaves the settings readable. */
  const fetchAll = useCallback(async (): Promise<{ view: ReviewView; groups: ReviewGroup[] | null }> => {
    const [view, groups] = await Promise.all([
      getReviewSettings(org ?? '', formId),
      listReviewGroups().catch((err: unknown) => {
        if (err instanceof ApiProblem && err.status === 403) return null;
        throw err;
      }),
    ]);
    return { view, groups };
  }, [org, formId]);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    void (async () => {
      // A form made a moment ago may not be on the server yet: send what is pending before asking about it.
      await flushAutosave().catch(() => undefined);
      try {
        const all = await fetchAll();
        if (live) show(all.view, all.groups);
      } catch (err) {
        if (live) setLoad({ status: 'blocked', reason: blockedBy(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [org, attempt, fetchAll, show]);

  const options = useMemo(() => targetOptions(def), [def]);
  const blocks = useMemo(() => unitBlocks(def), [def]);
  const problems = useMemo(() => unitProblems(def), [def]);
  const units = def.review?.units ?? [];

  const ready = load.status === 'ready' ? load : null;
  const groupList = ready ? ready.groups : null;
  const groupIds = useMemo(() => (groupList ? new Set(groupList.map((g) => g.id)) : null), [groupList]);
  const unitProblem = useMemo(() => (form ? assignmentProblems(form, def, groupIds) : {}), [form, def, groupIds]);
  const changed = ready !== null && form !== null && isChanged(form, inputOf(ready.view));
  const stuck = Object.keys(unitProblem).length > 0;
  const orphans = form ? orphansOf(form, def).length : 0;

  const edit = (patch: Partial<Settings>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setNotice(null);
    setError(null);
  };

  const save = async () => {
    if (org === null || form === null || ready === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The server accepts only units its copy of the draft has, so the draft goes first.
      await flushAutosave().catch(() => undefined);
      let sending = form;
      let saved: ReviewView;
      try {
        saved = await saveReviewSettings(org, formId, sending, ready.view.rev);
      } catch (err) {
        // Assignments of units that are in no version any more cannot be kept: send the rest, without making the author hunt for them.
        const without = err instanceof ReviewInvalid ? withoutRefusedOrphans(sending, def, err.fields) : null;
        if (without === null) throw err;
        sending = without;
        saved = await saveReviewSettings(org, formId, sending, ready.view.rev);
      }
      show(saved, ready.groups);
      setNotice(t(M['review.saved']));
    } catch (err) {
      if (err instanceof ReviewConflict) setConflict(true);
      else if (err instanceof ReviewInvalid) setError(t(M['review.refused'], { detail: err.fields.map((f) => `${f.path}: ${f.message}`).join('; ') || err.message }));
      else setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = await fetchAll();
      show(all.view, all.groups);
      setConflict(false);
      setNotice(t(M['review.reloaded']));
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  };

  const locked = ready === null;
  const explanation = load.status === 'blocked' ? t(BLOCKED_TEXT[load.reason]) : load.status === 'loading' ? t(M['review.loading']) : null;

  return (
    <section aria-label={t(M['review.title'])} className="space-y-5" aria-busy={load.status === 'loading'}>
      <p className="text-[12px] leading-5 text-sidebar-muted">{t(M['review.intro'])}</p>

      {explanation ? (
        <div className="space-y-2">
          <p className="text-[12px] text-muted-foreground" role="status">
            {explanation}
          </p>
          {load.status === 'blocked' && load.reason !== 'sign_in' && load.reason !== 'forbidden' ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setLoad({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t(M['review.retry'])}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <ToggleRow id="review-enabled" label={t(M['review.enabled'])} hint={t(M['review.enabled_hint'])} checked={form?.enabled ?? false} disabled={locked} onChange={(enabled) => edit({ enabled })} />
        <ToggleRow id="review-distinct" label={t(M['review.distinct'])} hint={t(M['review.distinct_hint'])} checked={form?.distinctCheckers ?? false} disabled={locked} onChange={(distinctCheckers) => edit({ distinctCheckers })} />
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-sidebar-foreground">{t(M['review.units_title'])}</h3>
          <p className="mt-1 text-[12px] leading-5 text-sidebar-muted">{t(M['review.units_hint'])}</p>
        </div>
        {ready && ready.groups === null ? <p className="text-[12px] text-muted-foreground">{t(M['review.groups_denied'])}</p> : null}
        {ready && ready.groups !== null && ready.groups.length === 0 && units.length > 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t(M['review.no_groups'])}{' '}
            <a className="underline" href="/org/members" target="_blank" rel="noreferrer">
              {t(M['review.members_link'])}
            </a>
          </p>
        ) : null}
        {units.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t(M['review.units_none'])}</p>
        ) : (
          <ul className="space-y-3">
            {units.map((unit) => (
              <UnitCard
                key={unit.id}
                unit={unit}
                target={describeTarget(def, unit.target)}
                blocks={blocks[unit.id] ?? []}
                problems={problems[unit.id] ?? []}
                assignment={form ? assignmentOf(form, unit.id) : undefined}
                groups={ready ? ready.groups : []}
                locked={locked}
                assignmentProblem={unitProblem[unit.id]}
                onAssign={(next) => form && edit(withAssignment(form, unit.id, next))}
              />
            ))}
          </ul>
        )}
        <AddUnit options={options} />
        {orphans > 0 ? <p className="text-[12px] text-muted-foreground">{t(M['review.orphans'], { count: orphans })}</p> : null}
      </div>

      <div className="space-y-2">
        <Button type="button" size="sm" disabled={busy || locked || !changed || stuck} onClick={() => void save()}>
          {t(M['review.save'])}
        </Button>
        {stuck ? <p className="text-[12px] text-muted-foreground">{t(M['review.fix_first'])}</p> : null}
        {notice ? (
          <Alert variant="info" icon>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {conflict ? (
          <Alert variant="warning" icon>
            <AlertDescription>
              <span className="block">{t(M['review.conflict'])}</span>
              <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => void reload()}>
                {t(M['review.reload'])}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" icon>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </section>
  );
}

function ToggleRow({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <Label htmlFor={id} className="text-sidebar-foreground">
          {label}
        </Label>
        <p className="mt-1 text-[12px] leading-5 text-sidebar-muted">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
