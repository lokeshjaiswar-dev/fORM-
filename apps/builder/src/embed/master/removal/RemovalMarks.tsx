import { Undo2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button } from '@dmacq/ui';
import type { RemovalMark } from './useRemovalMarks';

/**
 * The fields the author deleted that DMS still stores. They are not removed yet: Save to DMS asks for consent per field, and "Put back"
 * restores the block (so does Undo). Rendered only when there is something to show.
 */
export function RemovalMarks({ marks, onRestore }: { marks: readonly RemovalMark[]; onRestore: (id: string) => void }) {
  if (marks.length === 0) return null;
  return (
    <Alert variant="warning" data-testid="fp-removal-marks">
      <AlertTitle>{marks.length === 1 ? '1 field will be removed when you save' : `${marks.length} fields will be removed when you save`}</AlertTitle>
      <AlertDescription>
        <p>DMS asks you to confirm each one by name, and deletes the value it holds in every record. Nothing has been removed yet.</p>
        <ul className="mt-1 space-y-1">
          {marks.map((m) => (
            <li key={m.id} className="flex items-center gap-2" data-testid={`fp-removal-mark-${m.id}`}>
              <span className="min-w-0 flex-1 truncate line-through">{m.name}</span>
              <Button type="button" variant="ghost" size="sm" aria-label={`Put back ${m.name}`} onClick={() => onRestore(m.id)}>
                <Undo2 className="size-3.5" /> Put back
              </Button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
