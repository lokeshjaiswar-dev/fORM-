import type { ReactNode } from 'react';
import { FileText, LayoutTemplate } from 'lucide-react';
import { useUiStore } from '@/state/uiStore';

export function EmptyStart({ onTemplates }: { onTemplates: () => void }) {
  const startBlank = useUiStore((s) => s.startBlank);

  return (
    <div className="mt-10 space-y-8" onClick={(e) => e.stopPropagation()}>
      <div className="space-y-1">
        <StartRow icon={<FileText className="size-4" />} label="Press Enter to start building" onClick={startBlank} />
        <StartRow icon={<LayoutTemplate className="size-4" />} label="Start from a template" onClick={onTemplates} />
      </div>
      <p className="max-w-[520px] text-[15px] leading-7 text-[rgba(55,53,47,0.85)]">
        Build forms the way you write —{' '}
        <span className="rounded-[4px] bg-[#e8f0fe] px-1 py-0.5 font-medium text-[#1a73e8]">like a document</span>.
        <br />
        Type{' '}
        <span className="rounded-[4px] bg-[#e8f0fe] px-1.5 py-0.5 font-medium text-[#1a73e8]">/</span> to add a question
        or field.
      </p>
    </div>
  );
}

function StartRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 flex w-full items-center gap-3 rounded-[6px] px-2 py-2 text-left text-[15px] text-[rgba(55,53,47,0.55)] hover:bg-[rgba(55,53,47,0.05)] hover:text-[rgba(55,53,47,0.85)]"
    >
      <span className="flex size-5 items-center justify-center text-[rgba(55,53,47,0.45)]">{icon}</span>
      {label}
    </button>
  );
}
