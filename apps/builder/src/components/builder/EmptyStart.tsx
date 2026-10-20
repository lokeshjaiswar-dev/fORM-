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
      <p className="max-w-[520px] text-[15px] leading-7" style={{ color: 'var(--fr-text)' }}>
        {before}
        <span className="rounded-[4px] px-1 py-0.5 font-medium" style={{ background: 'color-mix(in srgb, var(--fr-accent) 16%, transparent)', color: 'var(--fr-accent)' }}>{t(M['start.intro_em'])}</span>
        {after}
        <br />
        {slashBefore}
        <span className="rounded-[4px] px-1.5 py-0.5 font-medium" style={{ background: 'color-mix(in srgb, var(--fr-accent) 16%, transparent)', color: 'var(--fr-accent)' }}>/</span>
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
      className="-ml-2 flex w-full items-center gap-3 rounded-[6px] px-2 py-2 text-left text-[15px] hover:bg-black/5"
      style={{ color: 'var(--fr-muted)' }}
    >
      <span className="flex size-5 items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}
