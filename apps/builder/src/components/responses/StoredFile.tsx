import { useEffect, useState } from 'react';
import { Download, FileText, Lock } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { loadSubmissionFile } from '@/persistence/filesApi';
import type { DetailFile } from '@/persistence/submissionsApi';
import { formatBytes } from '@/components/responses/format';

const M = defineMessages('builder', {
  'responses.file.download': 'Download {name}',
  'responses.file.failed': 'This file could not be downloaded.',
  'responses.file.protected': 'Protected file: it cannot be opened here.',
  'responses.file.signature': 'Signature',
});

/** Hands the browser a file to save under `name`, which is the one the server sent with it. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A picture (a signature or an uploaded image): fetched when the response opens, shown in place, with a link to save it. */
function ImageFile({ formId, file, id }: { formId: string; file: DetailFile; id: string }) {
  const [shown, setShown] = useState<{ url: string; name: string } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    let objectUrl: string | undefined;
    loadSubmissionFile(formId, id).then(
      (row) => {
        if (!live) return;
        if (!row) {
          setShown('failed');
          return;
        }
        objectUrl = URL.createObjectURL(row.blob);
        setShown({ url: objectUrl, name: row.name });
      },
      () => live && setShown('failed'),
    );
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [formId, id]);

  if (shown === 'failed') return <p role="alert" className="text-[13px] text-destructive">{t(M['responses.file.failed'])}</p>;
  if (shown === null) return <p className="text-[13px] text-muted-foreground">{file.name}</p>;
  return (
    <figure>
      <img src={shown.url} alt={file.purpose === 'signature' ? t(M['responses.file.signature']) : shown.name} className="max-h-52 max-w-full rounded-[8px] border border-border object-contain" />
      <figcaption className="mt-1 text-[13px]">
        <a href={shown.url} download={shown.name} className="text-primary underline">
          {t(M['responses.file.download'], { name: shown.name })}
        </a>
      </figcaption>
    </figure>
  );
}

/** Any other file: fetched only when the member asks for it, then saved under the server's name for it. */
function DownloadFile({ formId, file, id }: { formId: string; file: DetailFile; id: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  async function download() {
    setState('loading');
    try {
      const row = await loadSubmissionFile(formId, id);
      if (!row) {
        setState('failed');
        return;
      }
      saveBlob(row.blob, row.name);
      setState('idle');
    } catch {
      setState('failed');
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={state === 'loading'}
        onClick={() => void download()}
        aria-label={t(M['responses.file.download'], { name: file.name })}
        className="inline-flex items-center gap-2 rounded-[8px] border border-border px-3 py-1.5 text-[14px] hover:bg-state-hover disabled:opacity-60"
      >
        <FileText aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{file.name}</span>
        {file.sizeBytes === null ? null : <span className="shrink-0 text-[12px] text-muted-foreground">{formatBytes(file.sizeBytes)}</span>}
        <Download aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {state === 'failed' ? <p role="alert" className="mt-1 text-[13px] text-destructive">{t(M['responses.file.failed'])}</p> : null}
    </div>
  );
}

/**
 * A file a respondent uploaded, as the reader shows it. It is fetched through the API (`GET /v1/forms/:formId/files/:id`:
 * a signed-in member with `submissions.read`, the org's own copy, the type the upload check found) and never kept in
 * this browser. A file in a protected field is listed but cannot be opened until it can be revealed (WP-1.11).
 */
export function StoredFile({ formId, file }: { formId: string; file: DetailFile }) {
  if (file.masked || file.id === null) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Lock aria-hidden className="size-3.5 shrink-0" />
        {t(M['responses.file.protected'])}
      </p>
    );
  }
  return file.mime.startsWith('image/') ? <ImageFile formId={formId} file={file} id={file.id} /> : <DownloadFile formId={formId} file={file} id={file.id} />;
}
