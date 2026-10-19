import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { labelText } from '@/lib/v1html';
import { deleteBlock } from '@/state/actions';
import { rulesReading } from '@/state/commands/blocks';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import type { FormBlock } from '@/types/form';

const name = (block: FormBlock | undefined) => (block ? labelText(block.label).trim() || 'Untitled block' : '');

/** Deleting a block that rules read: lists those rules and lets the author remove or disable them (B21). */
export function DeleteBlockDialog() {
  const pending = useUiStore((s) => s.pendingDelete);
  const setPending = useUiStore((s) => s.setPendingDelete);
  const blocks = useDoc((d) => d.blocks);
  const target = blocks.find((b) => b.id === pending);
  const readers = pending ? rulesReading(blocks, pending) : [];
  const close = () => setPending(null);

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{name(target)}”?</DialogTitle>
          <DialogDescription>
            {readers.length === 1 ? 'A rule reads this block.' : `${readers.length} rules read this block.`} Remove them, or keep them
            disabled to fix later.
          </DialogDescription>
        </DialogHeader>
        <ul className="mb-5 list-disc space-y-1 pl-5 text-[14px]">
          {readers.map((reader) => (
            <li key={reader.id}>
              {reader.logic?.action === 'hide' ? 'Hide' : 'Show'} “{name(reader)}”
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => target && deleteBlock(target.id, 'disable')}>
            Disable rules
          </Button>
          <Button variant="destructive" onClick={() => target && deleteBlock(target.id, 'remove')}>
            Remove rules
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
