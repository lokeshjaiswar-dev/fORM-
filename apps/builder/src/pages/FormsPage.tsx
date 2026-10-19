import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { uid } from '@/lib/utils';
import { DOCUMENT_FORMAT, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { whenSaved } from '@/persistence/autosave';
import { importV1, newStoredForm } from '@/persistence/openForm';
import { useRepository } from '@/persistence/repository';
import { noteImport } from '@/persistence/useFormSession';
import { builderPath } from '@/pages/useBuilderMode';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function savedWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : ` · ${dateTime.format(at)}`;
}

/** The forms saved in this browser: open one, start a new one, or import a v1 JSON export. */
export function FormsPage() {
  const repo = useRepository();
  const navigate = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    whenSaved().then(() => repo.list()).then(
      (list) => live && setForms(list),
      () => live && setError('Saved forms could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [repo]);

  async function saveThenOpen(form: StoredForm): Promise<void> {
    try {
      await repo.save(form);
    } catch {
      setError('The form could not be saved in this browser.');
      return;
    }
    navigate(builderPath(form.id));
  }

  async function create() {
    setError(null);
    await saveThenOpen(newStoredForm(uid(), new Date().toISOString()));
  }

  async function importFile(picked: File) {
    setError(null);
    let json: unknown;
    try {
      json = JSON.parse(await picked.text());
    } catch {
      setError(`${picked.name} is not JSON.`);
      return;
    }
    const id = uid();
    const now = new Date().toISOString();
    const opened = importV1(json, id);
    if (!opened.ok) {
      setError(opened.error);
      return;
    }
    noteImport(id, opened.notes);
    await saveThenOpen({ id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc: opened.doc });
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-[var(--notion-text)]">
      <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">Forms</h1>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => void create()}>
          <Plus /> New form
        </Button>
        <Button variant="outline" onClick={() => file.current?.click()}>
          <Upload /> Import v1 JSON
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          aria-label="v1 JSON file"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) void importFile(picked);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-red-600">
          {error}
        </p>
      ) : null}
      {forms === null ? null : forms.length === 0 ? (
        <p className="mt-10 text-[15px] text-[var(--notion-text-muted)]">No forms yet. Start a new one or import a v1 export.</p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--notion-border)]">
          {forms.map((form) => (
            <li key={form.id}>
              <Link to={builderPath(form.id)} className="-mx-2 flex items-center gap-3 rounded-[6px] px-2 py-3 hover:bg-[var(--notion-hover)]">
                <FileText className="size-4 shrink-0 text-[var(--notion-text-faint)]" />
                <span className="min-w-0 flex-1 truncate text-[15px]">{form.title || 'Untitled form'}</span>
                <span className="shrink-0 text-[13px] text-[var(--notion-text-muted)]">
                  {form.blocks} {form.blocks === 1 ? 'block' : 'blocks'}
                  {savedWhen(form.savedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
