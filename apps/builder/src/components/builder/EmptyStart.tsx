import { useState, type ReactNode } from 'react';
import { FileText, LayoutTemplate } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useUiStore } from '@/state/uiStore';
import { TemplateDialog } from '@/components/templates/TemplateDialog';

const M = defineMessages('builder', {
  'start.blank': 'Press Enter to start building',
  'start.template': 'Start from a template',
  'start.intro': 'Build forms the way you write — {em}.',
  'start.intro_em': 'like a document',
  'start.slash': 'Type {slash} to add a question or field.',
});

export function EmptyStart() {
  const startBlank = useUiStore((s) => s.startBlank);
  const [templates, setTemplates] = useState(false);
  const [before, after] = t(M['start.intro'], { em: '\u0000' }).split('\u0000');
  const [slashBefore, slashAfter] = t(M['start.slash'], { slash: '\u0000' }).split('\u0000');

  return (
    <div className="mt-10 space-y-8" onClick={(e) => e.stopPropagation()}>
      <div className="space-y-1">
        <StartRow icon={<FileText className="size-4" />} label={t(M['start.blank'])} onClick={startBlank} />
        <StartRow icon={<LayoutTemplate className="size-4" />} label={t(M['start.template'])} onClick={() => setTemplates(true)} />
      </div>
      <p className="max-w-[520px] text-[15px] leading-7 text-[rgba(55,53,47,0.85)]">
        {before}
        <span className="rounded-[4px] bg-[#e8f0fe] px-1 py-0.5 font-medium text-[#1a73e8]">{t(M['start.intro_em'])}</span>
        {after}
        <br />
        {slashBefore}
        <span className="rounded-[4px] bg-[#e8f0fe] px-1.5 py-0.5 font-medium text-[#1a73e8]">/</span>
        {slashAfter}
      </p>
      <TemplateDialog open={templates} onOpenChange={setTemplates} />
    </div>
  );
}

function StartRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
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
