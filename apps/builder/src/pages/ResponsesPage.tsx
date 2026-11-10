import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { BUILDER_LOCALE, t } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { getRemoteSubmission, listRemoteSubmissions } from '@/persistence/submissionsApi';
import { useRepository } from '@/persistence/repository';
import { useSubmissions } from '@/persistence/SubmissionsContext';
import type { StoredSubmission, SubmissionSummary } from '@/persistence/SubmissionsRepository';

const M = defineMessages('builder', {
  'responses.title': 'Responses',
  'responses.back': 'Back to forms',
  'responses.empty': 'No submissions yet. Preview the form and submit it to see answers here.',
  'responses.unreadable': 'Saved responses could not be read.',
  'responses.missing': 'This form is not in this browser.',
  'responses.submitted': 'Submitted {when}',
  'responses.fields': '{n, plural, one {# field} other {# fields}}',
  'responses.view_data': 'View data',
  'responses.data_title': 'Submitted answers',
  'responses.close': 'Close',
  'responses.untitled': 'Untitled form',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateTime.format(at);
}

function merge(local: SubmissionSummary[], remote: SubmissionSummary[] | null): SubmissionSummary[] {
  const byId = new Map<string, SubmissionSummary>();
  for (const row of remote ?? []) byId.set(row.id, row);
  for (const row of local) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
}

export function ResponsesPage() {
  const { id = '' } = useParams();
  const forms = useRepository();
  const submissions = useSubmissions();
  const [title, setTitle] = useState<string | null>(null);
  const [items, setItems] = useState<SubmissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<StoredSubmission | null>(null);

  useEffect(() => {
    let live = true;
    forms.load(id).then(
      (form) => {
        if (!live) return;
        if (!form) setError(t(M['responses.missing']));
        else {
          const doc = form.doc as { title?: unknown };
          setTitle(typeof doc.title === 'string' && doc.title ? doc.title : t(M['responses.untitled']));
        }
      },
      () => live && setError(t(M['responses.unreadable'])),
    );
    Promise.all([submissions.listByForm(id), listRemoteSubmissions(id)]).then(
      ([local, remote]) => live && setItems(merge(local, remote)),
      () => live && setError(t(M['responses.unreadable'])),
    );
    return () => {
      live = false;
    };
  }, [forms, id, submissions]);

  async function view(row: SubmissionSummary) {
    const local = await submissions.get(id, row.id);
    const remote = local ? null : await getRemoteSubmission(id, row.id);
    setOpen(local ?? remote);
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-4">
        <Link to="/forms">
          <ArrowLeft />
          {t(M['responses.back'])}
        </Link>
      </Button>
      <h1 className="text-[32px] font-bold tracking-[-0.02em]">{title ?? t(M['responses.title'])}</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">{t(M['responses.title'])}</p>
      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-destructive">
          {error}
        </p>
      ) : null}
      {items === null ? null : items.length === 0 ? (
        <p className="mt-10 text-[15px] text-muted-foreground">{t(M['responses.empty'])}</p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {items.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px]">{t(M['responses.submitted'], { when: when(row.submittedAt) })}</p>
                <p className="text-[13px] text-muted-foreground">{t(M['responses.fields'], { n: row.fieldCount })}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void view(row)}>
                {t(M['responses.view_data'])}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(M['responses.data_title'])}</DialogTitle>
            <DialogDescription>{open ? t(M['responses.submitted'], { when: when(open.submittedAt) }) : null}</DialogDescription>
          </DialogHeader>
          {open && open.fields.length === 0 ? <p className="text-sm text-muted-foreground">{t(M['responses.empty'])}</p> : null}
          {open ? (
            <dl className="space-y-3">
              {open.fields.map((field) => (
                <div key={field.key}>
                  <dt className="text-[12px] font-medium text-muted-foreground">{field.label}</dt>
                  <dd className="text-[15px]">{field.value || '—'}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Button type="button" variant="outline" onClick={() => setOpen(null)}>
            {t(M['responses.close'])}
          </Button>
        </DialogContent>
      </Dialog>
    </main>
  );
}
