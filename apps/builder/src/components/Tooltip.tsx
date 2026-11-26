import type { ReactNode } from 'react';
import { Tooltip as DsTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@dmacq/ui';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

/** dMACQ Tooltip with `content` / `shortcut` props used across the builder chrome; looks as the Figma Tooltip (index.css). */
export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children,
  delay = 350,
  className,
}: {
  content: string;
  shortcut?: string | undefined;
  side?: Side;
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={delay}>
      <DsTooltip>
        <TooltipTrigger asChild>
          <span className={cn('inline-flex max-w-full', className)}>{children}</span>
        </TooltipTrigger>
        <TooltipContent side={side} shortcut={shortcut}>
          {content}
        </TooltipContent>
      </DsTooltip>
    </TooltipProvider>
  );
}

export function modKey() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
}
