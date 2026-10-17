import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const DialogCtx = createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({ open: false });

export function Dialog({
  open = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return <DialogCtx.Provider value={{ open, onOpenChange }}>{children}</DialogCtx.Provider>;
}

export function DialogContent({ className, children }: { className?: string; children: ReactNode }) {
  const { open, onOpenChange } = useContext(DialogCtx);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={() => onOpenChange?.(false)} />
      <div
        className={cn(
          'absolute left-1/2 top-1/2 z-10 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-[12px] border border-zinc-200 bg-white p-6 shadow-xl',
          className,
        )}
      >
        {children}
        <button
          type="button"
          className="absolute right-4 top-4 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          onClick={() => onOpenChange?.(false)}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mb-4 space-y-1', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold text-zinc-900', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-zinc-500', className)} {...props} />;
}
