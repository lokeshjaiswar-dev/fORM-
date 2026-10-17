import { cn } from '@/lib/utils';

export function Switch({
  checked,
  onCheckedChange,
  id,
  className,
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  id?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-zinc-900' : 'bg-zinc-200',
        className,
      )}
    >
      <span
        className={cn(
          'block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
