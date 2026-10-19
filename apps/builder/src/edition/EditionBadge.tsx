import { useEditionStore } from '@/edition/edition';
import { editionHint, editionLabel, editionName } from '@/edition/labels';
import { cn } from '@/lib/utils';

/** Which edition this builder talks to (FND-19), and what that means for the features on offer. */
export function EditionBadge({ className }: { className?: string }) {
  const state = useEditionStore();
  const hint = editionHint(state);
  return (
    <p
      role="note"
      aria-label={editionName()}
      title={hint}
      className={cn('inline-flex shrink-0 items-center rounded-[4px] bg-[var(--notion-hover)] px-1.5 py-0.5 text-[12px] text-[var(--notion-text-muted)]', className)}
    >
      {editionLabel(state.summary)}
    </p>
  );
}
