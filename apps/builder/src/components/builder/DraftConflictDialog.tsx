import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { defineMessages, type MessageId } from '@form/i18n';
import { FormDefinitionSchema, type FormDefinition } from '@form/schema';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dmacq/ui';
import { BUILDER_LOCALE, t } from '@/i18n';
import { diffDrafts, type BlockDiff, type FormPart } from '@/lib/draftDiff';
import { uid } from '@/lib/utils';
import { keepMine, takeTheirs } from '@/persistence/autosave';
import { newStoredForm } from '@/persistence/openForm';
import { useRepository } from '@/persistence/repository';
import { builderPath } from '@/pages/useBuilderMode';
import { currentDoc, useDoc } from '@/state/documentStore';
import { currentOps } from '@/state/opsStore';
import { useUiStore } from '@/state/uiStore';

const M = defineMessages('builder', {
  'conflict.title': 'This form changed somewhere else',
  'conflict.description': 'A newer version was saved from another tab, or by someone else, while you were editing. Nothing has been lost: choose which version to continue with.',
  'conflict.saved_at': 'The saved version is from {when}.',
  'conflict.mine_only': 'Only in your version',
  'conflict.theirs_only': 'Only in the saved version',
  'conflict.differs': 'Different in both',
  'conflict.parts': 'Form settings that differ',
  'conflict.same': 'The two versions have the same content.',
  'conflict.unreadable': 'The saved version cannot be shown. You can keep yours, or copy it to a new form.',
  'conflict.untitled': 'Untitled block',
  'conflict.part.title': 'Title',
  'conflict.part.pages': 'Page layout',
  'conflict.part.endings': 'Endings',
  'conflict.part.logic': 'Logic',
  'conflict.part.privacy': 'Privacy and consent',
  'conflict.part.theme': 'Design',
  'conflict.part.behavior': 'Behaviour',
  'conflict.part.i18n': 'Languages',
  'conflict.part.other': 'Other settings',
  'conflict.keep': 'Keep mine',
  'conflict.keep_hint': 'Save my version over the newer one.',
  'conflict.take': 'Take theirs',
  'conflict.take_hint': 'Discard my unsaved changes and use the saved version.',
  'conflict.copy': 'Copy mine to a new form',
  'conflict.copy_hint': 'Keep my version as a new form, and use the saved version here.',
  'conflict.copy_title': 'Copy of {title}',
  'conflict.copied': 'Your version was saved as a new form.',
  'conflict.open_copy': 'Open the copy',
  'conflict.failed': 'That did not work. Try again.',
});

const PARTS: Readonly<Record<FormPart, MessageId>> = {
  title: M['conflict.part.title'],
  pages: M['conflict.part.pages'],
  endings: M['conflict.part.endings'],
  logic: M['conflict.part.logic'],
  privacy: M['conflict.part.privacy'],
  theme: M['conflict.part.theme'],
  behavior: M['conflict.part.behavior'],
  i18n: M['conflict.part.i18n'],
  other: M['conflict.part.other'],
};

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateTime.format(at);
}

function Blocks({ heading, blocks }: { heading: string; blocks: BlockDiff[] }) {
  if (!blocks.length) return null;
  return (
    <section aria-label={heading}>
      <h3 className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="mt-1 space-y-0.5 text-[14px]">
        {blocks.map((block) => (
          <li key={block.id}>
            {block.label || t(M['conflict.untitled'])} <span className="text-text-subtle">{block.type}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The 409 merge prompt (WP-1.06): the server holds a newer draft than the one this tab saved on. Shows what differs,
 * block by block, and lets the author keep theirs, take the saved one, or copy theirs to a new form. It cannot be
 * dismissed: autosave stays paused until one of the three is chosen, so no choice is made by closing it.
 */
export function DraftConflictDialog() {
  const conflict = useUiStore((s) => s.draftConflict);
  /* Subscribed only while a conflict waits, so typing never re-renders the dialog. */
  const mine = useDoc((d) => (conflict ? d : null));
  const repo = useRepository();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const theirs = useMemo((): FormDefinition | null => {
    const parsed = conflict ? FormDefinitionSchema.safeParse(conflict.server.draft) : null;
    return parsed?.success ? (parsed.data as FormDefinition) : null;
  }, [conflict]);
  const diff = useMemo(() => (mine && theirs ? diffDrafts(mine, theirs) : null), [mine, theirs]);

  async function run(choice: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await choice();
    } catch {
      setError(t(M['conflict.failed']));
    } finally {
      setBusy(false);
    }
  }

  /** My version becomes a new form of its own; this one then shows the saved version, so the two are never mixed. */
  async function copyMine() {
    const id = uid();
    const doc = currentDoc();
    const title = t(M['conflict.copy_title'], { title: doc.title.trim() || t(M['conflict.untitled']) });
    await repo.save({ ...newStoredForm(id, new Date().toISOString(), { ...doc, title }), ops: { ...currentOps(), password: '' } });
    await takeTheirs();
    toast(t(M['conflict.copied']), { action: { label: t(M['conflict.open_copy']), onClick: () => navigate(builderPath(id)) } });
  }

  return (
    <Dialog open={conflict !== null}>
      <DialogContent size="md" dismissible={false} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t(M['conflict.title'])}</DialogTitle>
          <DialogDescription>
            {t(M['conflict.description'])}
            {conflict ? ` ${t(M['conflict.saved_at'], { when: when(conflict.server.updatedAt) })}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {diff === null ? <p className="text-[14px]">{t(M['conflict.unreadable'])}</p> : null}
          {diff?.identical ? <p className="text-[14px]">{t(M['conflict.same'])}</p> : null}
          {diff ? (
            <>
              <Blocks heading={t(M['conflict.mine_only'])} blocks={diff.onlyMine} />
              <Blocks heading={t(M['conflict.theirs_only'])} blocks={diff.onlyTheirs} />
              <Blocks heading={t(M['conflict.differs'])} blocks={diff.changed} />
              {diff.form.length ? (
                <section aria-label={t(M['conflict.parts'])}>
                  <h3 className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground">{t(M['conflict.parts'])}</h3>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[14px]">
                    {diff.form.map((part) => (
                      <li key={part}>{t(PARTS[part])}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
          <ul className="space-y-1 text-[13px] text-muted-foreground">
            <li>
              <strong className="font-medium text-foreground">{t(M['conflict.keep'])}</strong>: {t(M['conflict.keep_hint'])}
            </li>
            <li>
              <strong className="font-medium text-foreground">{t(M['conflict.take'])}</strong>: {t(M['conflict.take_hint'])}
            </li>
            <li>
              <strong className="font-medium text-foreground">{t(M['conflict.copy'])}</strong>: {t(M['conflict.copy_hint'])}
            </li>
          </ul>
          {error ? (
            <p role="alert" className="text-[14px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter stack="normal">
          <Button type="button" variant="outline" disabled={busy || theirs === null} onClick={() => void run(copyMine)}>
            {t(M['conflict.copy'])}
          </Button>
          <Button type="button" variant="outline" disabled={busy || theirs === null} onClick={() => void run(takeTheirs)}>
            {t(M['conflict.take'])}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void run(keepMine)}>
            {t(M['conflict.keep'])}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
