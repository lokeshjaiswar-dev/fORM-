import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Inbox, Pencil } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { rememberThemeImage, themeImageUrl } from '@form/renderer';
import type { FormDefinition, IsoInstant } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { PageHeader } from '@dmacq/ui/patterns';
import { WorkspaceShell } from '@/components/workspace/WorkspaceShell';
import { SortableHead, TablePagination, useTableView } from '@/components/workspace/tableView';
import { builderPath } from '@/pages/useBuilderMode';
import { readableFields, type AnswerMedia, type AnswerTable, type ReadableField } from '@/persistence/answerRows';
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

/** Grid view for matrix and dynamic-table answers: sticky header, row count, and a clear empty state. */
function AnswerGrid({ table }: { table: AnswerTable }) {
  const count = table.rows.length;
  return (
    <div className="overflow-hidden rounded-[8px] border border-border">
      <div className="ws-scroll-table max-h-[320px] overflow-auto">
        <table className="w-full min-w-max border-collapse text-left text-[14px]">
          <caption className="sr-only">{count === 1 ? '1 row' : `${count} rows`}</caption>
          <thead className="sticky top-0 z-10 bg-surface-subtle text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              {table.headers.map((header, i) => (
                <th key={`${header}-${i}`} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold">
                  {header || '\u00a0'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {count === 0 ? (
              <tr>
                <td colSpan={Math.max(table.headers.length, 1)} className="px-3 py-3 text-center text-muted-foreground">
                  No rows
                </td>
              </tr>
            ) : (
              table.rows.map((row, r) => (
                <tr key={r} className="align-top transition-colors hover:bg-surface-subtle">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2 whitespace-pre-wrap break-words">
                      {cell || <span className="text-muted-foreground">—</span>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {count > 0 ? (
        <div className="border-t border-border bg-surface-subtle px-3 py-1.5 text-[12px] text-muted-foreground">
          {count === 1 ? '1 row' : `${count} rows`}
        </div>
      ) : null}
    </div>
  );
}

/** Full-size value for the detail dialog: text plus any attached files or pictures. */
function FieldValue({ field }: { field: ReadableField }) {
  const files = field.media?.filter((item) => item.fileId) ?? [];
  const pictures = field.media?.filter((item) => item.assetId) ?? [];
  const fileNames = files.map((item) => item.name).join(', ');
  const hideFileName = files.length > 0 && (!field.value || field.value === fileNames);
  const showText = !!field.value && !hideFileName && !field.table && !field.choices;
  return (
    <>
      {showText ? <span className="whitespace-pre-wrap">{field.value}</span> : null}
      {field.choices ? (
        <ul className="flex flex-wrap gap-2" aria-label="Selected">
          {field.choices.map((choice, i) => (
            <li key={`${choice}-${i}`} className="rounded-full border border-border bg-surface-subtle px-3 py-1 text-[14px]">
              {choice}
            </li>
          ))}
        </ul>
      ) : null}
      {field.table ? <AnswerGrid table={field.table} /> : null}
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

  const sortAccessors = useMemo(() => {
    const accessors: Record<string, (row: (typeof rows)[number]) => string | number> = {
      submitted: (row) => new Date(row.record.submittedAt).getTime(),
    };
    for (const column of columns) {
      accessors[column.key] = (row) => cellText(row.byKey.get(column.key));
    }
    return accessors;
  }, [columns, rows]);

  const view = useTableView<(typeof rows)[number], string>(rows, sortAccessors, { key: 'submitted', dir: 'desc' });
  // The # column keeps each response's place in the order it was received, whatever the sort.
  const numberOf = useMemo(() => new Map(rows.map((row, i) => [row.record.id, rows.length - i])), [rows]);

  const openFields = open ? readableFields(definition, open).filter(hasContent) : [];

  return (
    <WorkspaceShell
      crumb={title ?? t(M['responses.title'])}
      actions={
        id ? (
          <Button variant="outline" size="sm" asChild>
            <Link to={builderPath(id)}>
              <Pencil />
              Open form
            </Link>
          </Button>
        ) : null
      }
    >
      <PageHeader
        title={title ?? t(M['responses.title'])}
        titleLevel={1}
        backHref="/forms"
        backLabel={t(M['responses.back'])}
        description={records === null ? 'Loading…' : responseCount(records.length)}
        status={<Badge variant="secondary">{t(M['responses.title'])}</Badge>}
      />

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
        <div className="ws-enter mt-6 overflow-hidden rounded-[12px] border border-border bg-background shadow-sm">
          <div className="ws-scroll-table overflow-auto">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead className="bg-surface-subtle text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-12 bg-surface-subtle px-4 py-3 font-semibold">#</th>
                <SortableHead
                  className="whitespace-nowrap"
                  label="Submitted"
                  sortKey="submitted"
                  active={view.sortKey}
                  dir={view.sortDir}
                  onSort={view.toggleSort}
                />
                {columns.map((column) => (
                  <SortableHead
                    key={column.key}
                    className="min-w-[160px]"
                    label={column.label}
                    sortKey={column.key}
                    active={view.sortKey}
                    dir={view.sortDir}
                    onSort={view.toggleSort}
                  />
                ))}
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">{t(M['responses.view_data'])}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.pageItems.map(({ record, byKey }) => (
                <tr key={record.id} className="align-top transition-colors hover:bg-surface-subtle">
                  <td className="sticky left-0 bg-background px-4 py-3 tabular-nums text-muted-foreground">{numberOf.get(record.id)}</td>
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
          <TablePagination
            page={view.page}
            pageCount={view.pageCount}
            total={view.total}
            pageSize={view.pageSize}
            onPage={view.setPage}
            onPageSize={view.setPageSize}
            noun="responses"
          />
        </div>
      )}

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-[640px]">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>{t(M['responses.data_title'])}</DialogTitle>
            <DialogDescription>{open ? t(M['responses.submitted'], { when: when(open.submittedAt) }) : null}</DialogDescription>
          </DialogHeader>
          {open ? (
            <dl className="divide-y divide-border px-6">
              {openFields.map((field) => (
                <div key={field.key} className="grid gap-1.5 py-4 sm:grid-cols-[180px_1fr] sm:gap-6">
                  <dt className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{field.label}</dt>
                  <dd className="text-[15px] leading-6">
                    <FieldValue field={field} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="flex justify-end border-t border-border bg-surface-subtle px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(null)}>
              {t(M['responses.close'])}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </WorkspaceShell>
  );
}
