import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TEMPLATES } from '@/data/templates';
import { useFormStore } from '@/store/useFormStore';
import { toast } from 'sonner';

export function TemplateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const loadTemplate = useFormStore((s) => s.loadTemplate);
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Templates</DialogTitle>
          <DialogDescription>Start from a pre-built form. This replaces your current blocks.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => setPendingId(tpl.id)}
              className="rounded-[6px] border border-[var(--notion-border)] p-4 text-left hover:bg-[var(--notion-hover)]"
            >
              <div className="font-medium">{tpl.name}</div>
              <p className="mt-1 text-sm text-[var(--notion-text-muted)]">{tpl.description}</p>
            </button>
          ))}
        </div>
        {pendingId && (
          <div className="mt-4 flex items-center justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm">
            <span>Replace the current form with this template?</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPendingId(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const tpl = TEMPLATES.find((t) => t.id === pendingId);
                  if (tpl) {
                    loadTemplate(tpl.schema);
                    toast.success(`Loaded “${tpl.name}”`);
                  }
                  setPendingId(null);
                  onOpenChange(false);
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
