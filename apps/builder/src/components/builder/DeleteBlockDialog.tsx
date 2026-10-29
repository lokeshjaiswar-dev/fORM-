import { defineMessages } from '@form/i18n';
import type { BlockId, FormDefinition, Rule } from '@form/schema';
import { t } from '@/i18n';
import { blockText } from '@/lib/definition';
import { deleteBlock } from '@/state/actions';
import { rulesReading } from '@/state/commands/rules';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dmacq/ui';

const M = defineMessages('builder', {
  'delete.title': 'Delete “{name}”?',
  'delete.untitled': 'Untitled block',
  'delete.readers': '{count, plural, one {A rule reads this block.} other {# rules read this block.}} Remove them, or keep them disabled to fix later.',
  'delete.show': 'Show “{name}”',
  'delete.hide': 'Hide “{name}”',
  'delete.page': 'a page',
  'delete.other': 'Rule {name}',
  'delete.cancel': 'Cancel',
  'delete.disable': 'Disable rules',
  'delete.remove': 'Remove rules',
});

function nameOf(def: FormDefinition, id: string): string {
  const block = def.blocks[id as BlockId];
  return block ? blockText(block) || t(M['delete.untitled']) : t(M['delete.page']);
}

/** A rule as the author knows it: what it shows or hides. */
function describe(rule: Rule, def: FormDefinition): string {
  const parts = rule.then.flatMap((action) =>
    action.type === 'show' || action.type === 'hide'
      ? action.targets.map((target) => t(action.type === 'show' ? M['delete.show'] : M['delete.hide'], { name: nameOf(def, target) }))
      : [],
  );
  return parts.length ? parts.join(', ') : t(M['delete.other'], { name: rule.name ?? rule.id });
}

/** Deleting a block that rules read: lists those rules and lets the author remove or disable them (B21). */
export function DeleteBlockDialog() {
  const pending = useUiStore((s) => s.pendingDelete);
  const setPending = useUiStore((s) => s.setPendingDelete);
  /* Subscribed only while a delete waits, so typing elsewhere never re-renders the dialog. */
  const def = useDoc((d) => (pending ? d : null));
  const target = pending && def ? def.blocks[pending] : undefined;
  const readers = pending && def ? rulesReading(def, pending) : [];
  const close = () => setPending(null);

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t(M['delete.title'], { name: blockText(target) || t(M['delete.untitled']) })}</DialogTitle>
          <DialogDescription>{t(M['delete.readers'], { count: readers.length })}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-[14px]">
          {readers.map((rule) => (
            <li key={rule.id}>{def ? describe(rule, def) : null}</li>
          ))}
        </ul>
        <DialogFooter stack="normal">
          <Button variant="ghost" onClick={close}>
            {t(M['delete.cancel'])}
          </Button>
          <Button variant="outline" onClick={() => pending && deleteBlock(pending, 'disable')}>
            {t(M['delete.disable'])}
          </Button>
          <Button variant="destructive" onClick={() => pending && deleteBlock(pending, 'remove')}>
            {t(M['delete.remove'])}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
