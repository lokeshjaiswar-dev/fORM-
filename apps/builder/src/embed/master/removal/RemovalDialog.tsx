import { useId, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@dmacq/ui';
import type { PendingRemoval } from './useRemovalConsent';

/**
 * One field's removal consent (SEC-DESIGN 7.3, test T-DMSINT-56). The text, the name box and the button carry the contract's test ids:
 * `fp-removal-dialog`, `fp-removal-confirm-name`, `fp-removal-confirm`. The button works only when the box holds the field name exactly
 * (capitals and spaces count), also for a field no record has a value in. Cancel (the button, Escape, a click outside) answers no.
 */
export function RemovalDialog({ pending }: { pending: PendingRemoval | null }) {
  if (!pending) return null;
  /* A new question (the next field, or the same field asked again with a new count) is a new box, so it starts with an empty name. */
  const key = `${pending.need.fieldId}:${pending.need.recount ? 'again' : 'first'}:${pending.need.count}`;
  return <RemovalBox key={key} pending={pending} />;
}

function RemovalBox({ pending }: { pending: PendingRemoval }) {
  const [typed, setTyped] = useState('');
  const nameId = useId();
  const { need, confirm, cancel } = pending;
  const matches = typed === need.name;

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent size="sm" data-testid="fp-removal-dialog">
        <DialogHeader>
          <DialogTitle>Remove this field?</DialogTitle>
          <DialogDescription>
            Removing <strong>{need.name}</strong> deletes its value in <strong>{need.count}</strong> records. DMS cannot restore them.
          </DialogDescription>
        </DialogHeader>
        {need.recount ? (
          <p role="status" className="text-[13px] text-destructive" data-testid="fp-removal-recount">
            More records now hold a value in this field than when you were first asked. Confirm the removal again.
          </p>
        ) : null}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches) confirm(typed);
          }}
        >
          <Label htmlFor={nameId} className="text-[13px]">
            Type the field name to confirm
          </Label>
          <Input id={nameId} data-testid="fp-removal-confirm-name" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </form>
        <DialogFooter stack="normal">
          <Button type="button" variant="ghost" data-testid="fp-removal-cancel" onClick={cancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" data-testid="fp-removal-confirm" disabled={!matches} onClick={() => matches && confirm(typed)}>
            Remove field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
