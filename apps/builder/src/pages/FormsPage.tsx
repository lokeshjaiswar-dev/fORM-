import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, Inbox, Plus, Upload } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { FormDefinition, IsoInstant } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { GalleryFallback } from '@/components/templates/TemplateDialog';
import { AccountMenu } from '@/auth/AccountMenu';
import { useSessionStore } from '@/auth/client';
import { EditionBadge } from '@/edition/EditionBadge';
import { TemplateGallery, preloadGallery } from '@/components/templates/gallery';
import { uid } from '@/lib/utils';
import { DOCUMENT_FORMAT, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { whenSaved } from '@/persistence/autosave';
import { importV1, newStoredForm } from '@/persistence/openForm';
import { useOptionalSubmissions } from '@/persistence/SubmissionsContext';
import { useRepository } from '@/persistence/repository';
import { noteImport } from '@/persistence/useFormSession';
import { builderPath } from '@/pages/useBuilderMode';

const M = defineMessages('builder', {
  'forms.title': 'Forms',
  'forms.new': 'New form',
  'forms.import': 'Import v1 JSON',
  'forms.import_label': 'v1 JSON file',
  'forms.empty': 'No forms yet. Start a new one or import a v1 export.',
  'forms.untitled': 'Untitled form',
  'forms.responses': 'Responses',
  'forms.responses_n': '{n, plural, one {# response} other {# responses}}',
  'forms.blocks': '{n, plural, one {# block} other {# blocks}}',
  'forms.unreadable': 'Saved forms could not be read.',
  'forms.not_saved': 'The form could not be saved in this browser.',
  'forms.not_json': '{name} is not JSON.',
  'new.title': 'New form',
  'new.description': 'Start from a blank form or from a template. Templates work offline.',
  'new.blank': 'Blank form',
  'new.blank_hint': 'An empty page to build on',
  'new.templates': 'From a template',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function savedWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : ` · ${dateTime.format(at)}`;
}

/** The forms saved in this browser: open one, start a new one (blank or from a template), or import a v1 JSON export. */
export function FormsPage() {
  const repo = useRepository();
  const session = useSessionStore((s) => s.status);
  const submissions = useOptionalSubmissions();
  const navigate = useNavigate();
  const file = useRef<HTMLInputElement>(null);
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(preloadGallery, []);

  useEffect(() => {
    if (session === 'unknown') return;
    let live = true;
    whenSaved().then(() => repo.list()).then(
      (list) => live && setForms(list),
      () => live && setError(t(M['forms.unreadable'])),
    );
    return () => {
      live = false;
    };
  }, [repo, session]);

  useEffect(() => {
    if (!submissions || !forms) return;
    let live = true;
    Promise.all(forms.map(async (form) => [form.id, (await submissions.listByForm(form.id)).length] as const)).then(
      (pairs) => {
        if (!live) return;
        setCounts(Object.fromEntries(pairs));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [forms, submissions]);

  async function saveThenOpen(form: StoredForm): Promise<void> {
    try {
      await repo.save(form);
    } catch {
      setError(t(M['forms.not_saved']));
      return;
    }
    navigate(builderPath(form.id));
  }

  async function create(doc?: FormDefinition) {
    setError(null);
    setCreating(false);
    const id = uid();
    const now = new Date().toISOString();
    await saveThenOpen(doc ? newStoredForm(id, now, doc) : newStoredForm(id, now));
  }

  async function importFile(picked: File) {
    setError(null);
    let json: unknown;
    try {
      json = JSON.parse(await picked.text());
    } catch {
      setError(t(M['forms.not_json'], { name: picked.name }));
      return;
    }
    const id = uid();
    const now = new Date().toISOString();
    const opened = importV1(json, id, now as IsoInstant);
    if (!opened.ok) {
      setError(opened.error);
      return;
    }
    noteImport(id, opened.notes);
    await saveThenOpen({ id, format: DOCUMENT_FORMAT, rev: 0, savedAt: now, doc: opened.doc, ops: opened.ops });
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
      <div className="-mt-12 mb-6 flex justify-end">
        <AccountMenu />
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['forms.title'])}</h1>
        <EditionBadge />
      </div>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => setCreating(true)}>
          <Plus /> {t(M['forms.new'])}
        </Button>
        <Button variant="outline" onClick={() => file.current?.click()}>
          <Upload /> {t(M['forms.import'])}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          aria-label={t(M['forms.import_label'])}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) void importFile(picked);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-destructive">
          {error}
        </p>
      ) : null}
      {forms === null ? null : forms.length === 0 ? (
        <p className="mt-10 text-[15px] text-muted-foreground">{t(M['forms.empty'])}</p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {forms.map((form) => (
            <li key={form.id} className="-mx-2 flex items-center gap-2 rounded-[6px] px-2 py-3 hover:bg-state-hover">
              <Link to={builderPath(form.id)} className="flex min-w-0 flex-1 items-center gap-3">
                <FileText className="size-4 shrink-0 text-text-subtle" />
                <span className="min-w-0 flex-1 truncate text-[15px]">{form.title || t(M['forms.untitled'])}</span>
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  {t(M['forms.blocks'], { n: form.blocks })}
                  {savedWhen(form.savedAt)}
                </span>
              </Link>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/forms/${form.id}/responses`} onClick={(e) => e.stopPropagation()}>
                  <Inbox />
                  {t(M['forms.responses'])}
                  {counts[form.id] ? ` · ${t(M['forms.responses_n'], { n: counts[form.id] ?? 0 })}` : ''}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(M['new.title'])}</DialogTitle>
            <DialogDescription>{t(M['new.description'])}</DialogDescription>
          </DialogHeader>
          <Button
            type="button"
            variant="outline"
            onClick={() => void create()}
            className="mb-4 h-auto w-full items-start justify-start gap-3 whitespace-normal p-4 text-left"
          >
            <Plus className="size-4 shrink-0" />
            <span>
              <span className="block font-medium">{t(M['new.blank'])}</span>
              <span className="block text-sm font-normal text-muted-foreground">{t(M['new.blank_hint'])}</span>
            </span>
          </Button>
          <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['new.templates'])}</p>
          <Suspense fallback={<GalleryFallback />}>
            <TemplateGallery onCancel={() => setCreating(false)} onUse={(definition) => void create(definition)} />
          </Suspense>
        </DialogContent>
      </Dialog>
    </main>
  );
}
