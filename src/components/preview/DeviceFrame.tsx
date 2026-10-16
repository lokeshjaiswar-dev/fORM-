import type { ReactNode } from 'react';
import type { PreviewDevice } from '@/types/form';

const screenScroll =
  'absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

export function DeviceFrame({ device, children }: { device: PreviewDevice; children: ReactNode }) {
  if (device === 'mobile') {
    return (
      <div className="relative mx-auto flex h-[640px] max-h-full w-full max-w-[340px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col rounded-[42px] bg-[#1c1c1e] p-[10px] shadow-[0_24px_60px_rgba(0,0,0,0.28)] ring-1 ring-black/40">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[32px] bg-white">
            <div className="pointer-events-none absolute left-1/2 top-2 z-10 h-[22px] w-[92px] -translate-x-1/2 rounded-full bg-[#1c1c1e]" />
            <div className={screenScroll}>{children}</div>
            <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 h-1 w-28 -translate-x-1/2 rounded-full bg-white/40" />
          </div>
        </div>
      </div>
    );
  }

  if (device === 'tablet') {
    return (
      <div className="relative mx-auto flex h-[680px] max-h-full w-full max-w-[520px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col rounded-[28px] bg-[#2c2c2e] p-[14px] shadow-[0_24px_60px_rgba(0,0,0,0.22)] ring-1 ring-black/30">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[16px] bg-white">
            <div className="pointer-events-none absolute left-1/2 top-2 z-10 size-2 -translate-x-1/2 rounded-full bg-[#636366]" />
            <div className={screenScroll}>{children}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[640px] max-h-full w-full max-w-[920px] shrink-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col rounded-t-[14px] bg-[#3a3a3c] p-3 pb-0 shadow-[0_24px_60px_rgba(0,0,0,0.18)]">
        <div className="mb-2 flex shrink-0 items-center gap-1.5 px-1">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
          <span className="mx-auto h-4 w-[42%] rounded-md bg-[#2c2c2e]" />
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-t-[8px] bg-white">
          <div className={screenScroll}>{children}</div>
        </div>
      </div>
      <div className="h-3 w-full shrink-0 rounded-b-[18px] bg-[#d4d4d8]" />
      <div className="mx-auto h-2 w-[28%] shrink-0 rounded-b-md bg-[#a1a1aa]" />
    </div>
  );
}
