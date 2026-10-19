import { useEffect, useState } from 'react';
import type { IsoInstant } from '@form/schema';
import { localizationOf, type Formpack } from '@form/templates';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GALLERY_LOCALE, formFromTemplate, loadSystemPack } from '@/lib/systemPack';
import { uid } from '@/lib/utils';
import { replaceDocument } from '@/state/actions';
import { toast } from 'sonner';

export function TemplateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [pack, setPack] = useState<Formpack | null>(null);
  const [failed, setFailed] = useState(false);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!open || pack) return;
    let live = true;
    loadSystemPack().then(
      (p) => live && setPack(p),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, pack]);

  const use = (slug: string) => {
    const template = pack?.templates.find((t) => t.entry.slug === slug);
    if (pack && template) {
      const { form } = formFromTemplate(pack, template, { idSeed: uid(), bindingIdSeed: uid(), now: new Date().toISOString() as IsoInstant });
      const title = localizationOf(template.file, GALLERY_LOCALE)?.title ?? slug;
      if (replaceDocument(form).ok) toast.success(`Loaded “${title}”`);
      else toast.error(`“${title}” could not be loaded into this form`);
    }
    setPendingSlug(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Templates</DialogTitle>
          <DialogDescription>Start from a pre-built form. This replaces your current blocks.</DialogDescription>
        </DialogHeader>
        {failed ? (
          <p role="alert" className="text-sm text-[var(--notion-text-muted)]">
            The template pack could not be verified.
          </p>
        ) : !pack ? (
          <p className="text-sm text-[var(--notion-text-muted)]">Loading templates…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {pack.templates.map((tpl) => {
              const text = localizationOf(tpl.file, GALLERY_LOCALE);
              return (
                <button
                  key={tpl.entry.slug}
                  type="button"
                  onClick={() => setPendingSlug(tpl.entry.slug)}
                  className="rounded-[6px] border border-[var(--notion-border)] p-4 text-left hover:bg-[var(--notion-hover)]"
                >
                  <div className="font-medium">{text?.title ?? tpl.entry.slug}</div>
                  <p className="mt-1 text-sm text-[var(--notion-text-muted)]">{text?.summary}</p>
                </button>
              );
            })}
          </div>
        )}
        {pendingSlug && (
          <div className="mt-4 flex items-center justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm">
            <span>Replace the current form with this template?</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPendingSlug(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => use(pendingSlug)}>
                Confirm
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
