import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Inbox } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { rememberThemeImage, themeImageUrl } from '@form/renderer';
import type { FormDefinition, IsoInstant } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { builderPath } from '@/pages/useBuilderMode';
import { readableFields, type AnswerMedia, type ReadableField } from '@/persistence/answerRows';
import { loadSubmissionFile } from '@/persistence/filesApi';
import { getRemoteSubmission, listRemoteSubmissions } from '@/persistence/submissionsApi';
import { useRepository } from '@/persistence/repository';
import { useSubmissions } from '@/persistence/SubmissionsContext';
import type { StoredSubmission, SubmissionSummary } from '@/persistence/SubmissionsRepository';
import { openStored } from '@/persistence/openForm';
import { API_BASE } from '@/edition/edition';
import { rememberedSlug } from '@/persistence/publishApi';

const M = defineMessages('builder', {
  'responses.title': 'Responses',
  'responses.back': 'Back to forms',
  'responses.empty': 'No submissions yet. Preview the form and submit it to see answers here.',
  'responses.unreadable': 'Saved responses could not be read.',
  'responses.missing': 'This form is not in this browser.',
  'responses.submitted': 'Submitted {when}',
  'responses.view_data': 'View',
  'responses.data_title': 'Submitted answers',
  'responses.close': 'Close',
  'responses.untitled': 'Untitled form',
});

function responseCount(n: number): string {
  return n === 1 ? '1 response' : `${n} responses`;
}

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

/** A field carries something worth showing: text or an attached file or picture. */
function hasContent(field: ReadableField | undefined): boolean {
  return !!field && (!!field.value.trim() || !!field.media?.length);
}

function StoredFile({ fileId, name, mime }: { fileId: string; name: string; mime?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [resolvedMime, setMime] = useState(mime ?? '');
  useEffect(() => {
    let objectUrl: string | undefined;
    let live = true;
    loadSubmissionFile(fileId).then((row) => {
      if (!live || !row) return;
      objectUrl = URL.createObjectURL(row.blob);
      setUrl(objectUrl);
      if (row.mime) setMime(row.mime);
    }).catch(() => undefined);
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);
  const image = resolvedMime.startsWith('image/') || (mime ?? '').startsWith('image/');
  if (url && image) return <img src={url} alt={name} className="mt-2 max-h-52 max-w-full rounded-[8px] border border-border object-contain" />;
  if (url) {
    return (
      <a href={url} download={name} className="mt-1 inline-block text-[14px] text-primary underline">
        {name}
      </a>
    );
  }
  return <span className="text-[15px]">{name}</span>;
}

function FieldMedia({ media }: { media: AnswerMedia[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {media.map((item, i) => {
        if (item.fileId) return <StoredFile key={item.fileId} fileId={item.fileId} name={item.name} {...(item.mime ? { mime: item.mime } : {})} />;
        if (item.assetId) {
          const src = themeImageUrl(item.assetId);
          return src ? <img key={`${item.assetId}-${i}`} src={src} alt={item.name} className="size-20 rounded-[8px] border border-border object-cover" /> : null;
        }
        return null;
      })}
    </div>
  );
}

/** Full-size value for the detail dialog: text plus any attached files or pictures. */
function FieldValue({ field }: { field: ReadableField }) {
  const files = field.media?.filter((item) => item.fileId) ?? [];
  const pictures = field.media?.filter((item) => item.assetId) ?? [];
  const fileNames = files.map((item) => item.name).join(', ');
  const hideFileName = files.length > 0 && (!field.value || field.value === fileNames);
  return (
    <>
      {field.value && !hideFileName ? <span className="whitespace-pre-wrap">{field.value}</span> : null}
      {pictures.length ? <FieldMedia media={pictures} /> : null}
      {files.length ? <FieldMedia media={files} /> : null}
    </>
  );
}

/** Short text for a table cell; attachments are listed by name, full previews live in the dialog. */
function cellText(field: ReadableField | undefined): string {
  if (!field) return '';
  const names = field.media?.map((item) => item.name).filter(Boolean) ?? [];
  const parts = [field.value.trim(), ...names].filter((part, i, all) => part && all.indexOf(part) === i);
  return parts.join(', ');
}

export function ResponsesPage() {
  const { id = '' } = useParams();
  const forms = useRepository();
  const submissions = useSubmissions();
  const [title, setTitle] = useState<string | null>(null);
  const [definition, setDefinition] = useState<FormDefinition | null>(null);
  const [records, setRecords] = useState<StoredSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<StoredSubmission | null>(null);

  useEffect(() => {
    let live = true;
    forms.load(id).then(
      (form) => {
        if (!live) return;
        if (!form) {
          setError(t(M['responses.missing']));
          return;
        }
        const opened = openStored(form, new Date().toISOString() as IsoInstant);
        if (opened.ok) {
          setDefinition(opened.doc);
          setTitle(opened.doc.title.trim() || t(M['responses.untitled']));
        } else {
          const doc = form.doc as { title?: unknown };
          setTitle(typeof doc.title === 'string' && doc.title ? doc.title : t(M['responses.untitled']));
        }
      },
      () => live && setError(t(M['responses.unreadable'])),
    );
    const slug = rememberedSlug(id);
    if (slug) {
      void fetch(`${API_BASE}/v1/p/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { media?: Record<string, string> } | null) => {
          if (!body?.media) return;
          for (const [assetId, url] of Object.entries(body.media)) {
            if (url.startsWith('data:image/')) rememberThemeImage(assetId, url);
          }
        })
        .catch(() => undefined);
    }
    Promise.all([submissions.listByForm(id), listRemoteSubmissions(id)])
      .then(async ([local, remote]) => {
        const items = merge(local, remote);
        const details = await Promise.all(
          items.map(async (row) => (await submissions.get(id, row.id)) ?? (await getRemoteSubmission(id, row.id))),
        );
        if (live) setRecords(details.filter((row): row is StoredSubmission => row !== null));
      })
      .catch(() => live && setError(t(M['responses.unreadable'])));
    return () => {
      live = false;
    };
  }, [forms, id, submissions]);

  const rows = useMemo(
    () =>
      (records ?? []).map((record) => {
        const fields = readableFields(definition, record);
        return { record, fields, byKey: new Map(fields.map((field) => [field.key, field])) };
      }),
    [definition, records],
  );

  /** Only fields that have an answer in at least one response, in form order. */
  const columns = useMemo(() => {
    const seen = new Map<string, ReadableField>();
    for (const row of rows) {
      for (const field of row.fields) {
        if (!seen.has(field.key) && hasContent(field)) seen.set(field.key, field);
      }
    }
    return [...seen.values()];
  }, [rows]);

  const openFields = open ? readableFields(definition, open).filter(hasContent) : [];

  return (
    <main className="mx-auto w-full max-w-[1200px] px-8 pb-24 pt-[72px] text-foreground">
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-6">
        <Link to="/forms">
          <ArrowLeft />
          {t(M['responses.back'])}
        </Link>
      </Button>

      <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-muted-foreground">{t(M['responses.title'])}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[32px] font-bold leading-[1.15] tracking-[-0.02em]">{title ?? t(M['responses.title'])}</h1>
        {id ? (
          <Button variant="outline" size="sm" asChild>
            <Link to={builderPath(id)}>Open form</Link>
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-[15px] text-muted-foreground">
        {records === null ? 'Loading…' : responseCount(records.length)}
      </p>

      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-destructive">
          {error}
        </p>
      ) : null}

      {records === null ? null : records.length === 0 ? (
        <div className="mt-10 flex flex-col items-center rounded-[12px] border border-dashed border-border bg-surface-subtle px-6 py-14 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
            <Inbox className="size-5" />
          </span>
          <p className="mt-4 max-w-[360px] text-[15px] leading-6 text-muted-foreground">{t(M['responses.empty'])}</p>
        </div>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-[12px] border border-border bg-background">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead className="bg-surface-subtle text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-12 bg-surface-subtle px-4 py-3 font-semibold">#</th>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">{t(M['responses.title'])}</th>
                {columns.map((column) => (
                  <th key={column.key} scope="col" className="min-w-[160px] px-4 py-3 font-semibold">
                    {column.label}
                  </th>
                ))}
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">{t(M['responses.view_data'])}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ record, byKey }, index) => (
                <tr key={record.id} className="align-top transition-colors hover:bg-surface-subtle">
                  <td className="sticky left-0 bg-background px-4 py-3 tabular-nums text-muted-foreground">{rows.length - index}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(record.submittedAt)}</td>
                  {columns.map((column) => {
                    const text = cellText(byKey.get(column.key));
                    return (
                      <td key={column.key} className="max-w-[280px] px-4 py-3 break-words">
                        {text}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" size="sm" onClick={() => setOpen(record)}>
                      {t(M['responses.view_data'])}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t(M['responses.data_title'])}</DialogTitle>
            <DialogDescription>{open ? t(M['responses.submitted'], { when: when(open.submittedAt) }) : null}</DialogDescription>
          </DialogHeader>
          {open ? (
            <dl className="space-y-0">
              {openFields.map((field, i) => (
                <div key={field.key} className={i === 0 ? 'pb-4' : 'border-t border-border py-4'}>
                  <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{field.label}</dt>
                  <dd className="mt-1.5 text-[16px] leading-6">
                    <FieldValue field={field} />
                  </dd>
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
