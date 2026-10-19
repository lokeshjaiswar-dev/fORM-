import { Suspense } from 'react';
import { toast } from 'sonner';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { replaceDocument } from '@/state/actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TemplateGallery } from '@/components/templates/gallery';

const M = defineMessages('builder', {
  'templates.title': 'Templates',
  'templates.description': 'Start from a pre-built form.',
  'templates.replace': 'This replaces the blocks, rules and settings of the current form. You can undo it.',
  'templates.use': 'Replace this form',
  'templates.loading': 'Loading templates…',
  'templates.loaded': 'Loaded “{title}”',
  'templates.refused': '“{title}” could not be loaded into this form',
});

export function GalleryFallback() {
  return <p className="text-sm text-[var(--notion-text-muted)]">{t(M['templates.loading'])}</p>;
}

/** Templates for the open form: the chosen template replaces it as one undoable step. */
export function TemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(M['templates.title'])}</DialogTitle>
          <DialogDescription>{t(M['templates.description'])}</DialogDescription>
        </DialogHeader>
        <Suspense fallback={<GalleryFallback />}>
          <TemplateGallery
            notice={t(M['templates.replace'])}
            useLabel={t(M['templates.use'])}
            onCancel={() => onOpenChange(false)}
            onUse={(definition, title) => {
              if (replaceDocument(definition).ok) toast.success(t(M['templates.loaded'], { title }));
              else toast.error(t(M['templates.refused'], { title }));
              onOpenChange(false);
            }}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
