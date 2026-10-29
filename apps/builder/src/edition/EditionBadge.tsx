import { Badge } from '@dmacq/ui';
import { useEditionStore } from '@/edition/edition';
import { editionHint, editionLabel, editionName } from '@/edition/labels';
import { cn } from '@/lib/utils';

/** Which edition this builder talks to (FND-19), and what that means for the features on offer. */
export function EditionBadge({ className }: { className?: string }) {
  const state = useEditionStore();
  const hint = editionHint(state);
  return (
    <Badge
      asChild
      variant="secondary"
      size="sm"
      className={cn('shrink-0 font-normal', className)}
    >
      <p role="note" aria-label={editionName()} title={hint}>
        {editionLabel(state.summary)}
      </p>
    </Badge>
  );
}
