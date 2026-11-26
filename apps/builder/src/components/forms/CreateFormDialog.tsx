import { Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { FormDefinition } from '@form/schema';
import { t } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@dmacq/ui';
import { GalleryFallback } from '@/components/templates/TemplateDialog';
import { TemplateGallery, preloadGallery } from '@/components/templates/gallery';
import '@/components/forms/createForm.css';

const M = defineMessages('builder', {
  'create.title': 'Create a form',
  'create.description': 'Choose how you want to start. You can edit everything later.',
  'create.scratch': 'Start from scratch',
  'create.scratch_hint': 'Begin with a blank form and add only the fields you need. Best for unique or one-off forms.',
  'create.template': 'Start from a template',
  'create.template_hint': 'Pick a ready-made form with fields set up, then edit it. Best for common forms you need fast.',
  'create.templates_title': 'Choose a template',
  'create.templates_description': 'Every template is a normal form: change any question, colour or rule after you pick it.',
  'create.back': 'Back',
});

export type CreateStep = 'choose' | 'templates';

/**
 * Figma DMacq Design System 5412:2253, "Create form · Choose how to start": the overlay that opens from New form. Two
 * large choices, each with an illustration of what it gives you. Start from scratch creates a blank form at once;
 * Start from a template moves to a second step in the same window (with Back), so the author never loses their place.
 */
export function CreateFormDialog({
  open,
  onOpenChange,
  initialStep = 'choose',
  onBlank,
  onTemplate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStep?: CreateStep;
  onBlank: () => void;
  onTemplate: (definition: FormDefinition) => void;
}) {
  const [step, setStep] = useState<CreateStep>(initialStep);
  /* Every opening starts where the caller asked: New form at the choice, Browse templates at the templates. */
  useEffect(() => {
    if (open) setStep(initialStep);
  }, [open, initialStep]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="create-form-dialog max-h-[90vh] w-[calc(100vw-32px)] max-w-[846px] gap-0 overflow-y-auto rounded-[8px] p-0 sm:max-w-[846px]">
        {step === 'choose' ? (
          <ChooseStep onBlank={onBlank} onTemplates={() => setStep('templates')} />
        ) : (
          <TemplatesStep onBack={() => setStep('choose')} onCancel={() => onOpenChange(false)} onUse={onTemplate} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChooseStep({ onBlank, onTemplates }: { onBlank: () => void; onTemplates: () => void }) {
  return (
    <div className="flex flex-col gap-8 p-6 sm:p-10">
      <header className="flex flex-col gap-1 pr-8">
        <DialogTitle className="text-[24px] font-extrabold leading-8 text-(--bluedark-1000)">{t(M['create.title'])}</DialogTitle>
        <DialogDescription className="text-[16px] font-medium leading-6 text-(--bluedark-800) sm:text-[18px] sm:leading-[26px]">{t(M['create.description'])}</DialogDescription>
      </header>
      <div className="grid gap-6 sm:grid-cols-2">
        <StartCard title={t(M['create.scratch'])} hint={t(M['create.scratch_hint'])} onPick={onBlank} illustration={<ScratchIllustration />} />
        {/* Load the gallery while the author reads, so the next step opens without a wait. */}
        <StartCard title={t(M['create.template'])} hint={t(M['create.template_hint'])} onPick={onTemplates} onIntent={preloadGallery} illustration={<TemplateIllustration />} />
      </div>
    </div>
  );
}

/** One way to start: the whole card is the button; it lifts on hover and shows the focus ring from the keyboard. */
function StartCard({ title, hint, onPick, onIntent, illustration }: { title: string; hint: string; onPick: () => void; onIntent?: () => void; illustration: ReactNode }) {
  const titleId = useId();
  const hintId = useId();
  return (
    <button
      type="button"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onClick={onPick}
      onPointerEnter={onIntent}
      onFocus={onIntent}
      className="create-card group flex flex-col gap-4 rounded-[12px] border border-[#dae2ed] bg-white px-2 pb-5 pt-2 text-left outline-none transition-[border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-(--bluedark-500) hover:shadow-[0_8px_24px_rgba(25,40,57,0.12)] focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-0"
    >
      <span aria-hidden className="relative block h-[200px] w-full overflow-hidden rounded-[8px] bg-(--bluedark-100)">
        {illustration}
      </span>
      <span className="flex flex-col gap-1.5 px-3">
        <span id={titleId} className="text-[16px] font-bold leading-6 text-(--bluedark-1000)">{title}</span>
        <span id={hintId} className="text-[13px] font-medium leading-[19px] text-(--bluedark-800)">{hint}</span>
      </span>
    </button>
  );
}

function TemplatesStep({ onBack, onCancel, onUse }: { onBack: () => void; onCancel: () => void; onUse: (definition: FormDefinition) => void }) {
  return (
    <div className="flex flex-col gap-6 p-6 sm:p-10">
      <header className="flex items-start gap-3 pr-8">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['create.back'])} onClick={onBack} className="mt-1 shrink-0">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex flex-col gap-1">
          <DialogTitle className="text-[24px] font-extrabold leading-8 text-(--bluedark-1000)">{t(M['create.templates_title'])}</DialogTitle>
          <DialogDescription className="text-[14px] font-medium leading-5 text-(--bluedark-800)">{t(M['create.templates_description'])}</DialogDescription>
        </div>
      </header>
      <Suspense fallback={<GalleryFallback />}>
        <TemplateGallery onCancel={onCancel} onUse={onUse} />
      </Suspense>
    </div>
  );
}

/* Figma "Blank form": a page with a dashed empty area; three fields drop in one after another as the + is pressed. */
function ScratchIllustration() {
  return (
    <span className="absolute left-1/2 top-[14px] block h-[174px] w-[156px] -translate-x-1/2 rounded-[8px] border border-[#dae2ed] bg-white shadow-[0_4px_6px_rgba(25,40,57,0.08)]">
      <span className="absolute left-[13px] top-[15px] block h-2 w-16 rounded-[4px] bg-[#dae2ed]" />
      <span className="absolute left-[9px] top-[33px] block h-[98px] w-[136px] rounded-[6px] border border-dashed border-[#b1c1d2]" />
      <span className="cf-field cf-field-1 absolute left-[17px] top-[41px] block h-6 w-[120px]">
        <span className="absolute left-0 top-0 block h-[5px] w-10 rounded-full bg-[#dae2ed]" />
        <span className="absolute left-0 top-[9px] block h-[15px] w-[120px] rounded-[3px] border border-[#dae2ed] bg-white" />
      </span>
      <span className="cf-field cf-field-2 absolute left-[17px] top-[71px] block h-6 w-[120px]">
        <span className="absolute left-0 top-0 block h-[5px] w-[52px] rounded-full bg-[#dae2ed]" />
        <span className="absolute left-0 top-[9px] block h-[15px] w-[120px] rounded-[3px] border border-[#dae2ed] bg-white" />
      </span>
      <span className="cf-field cf-field-3 absolute left-[17px] top-[101px] block h-6 w-[120px]">
        <span className="absolute left-0 top-0 block h-[5px] w-10 rounded-full bg-[#dae2ed]" />
        <span className="absolute left-0 top-[10px] block size-[11px] rounded-[3px] bg-[#2950da]" />
        <span className="absolute left-[17px] top-[13px] block h-[5px] w-[60px] rounded-full bg-[#dae2ed]" />
      </span>
      <span className="cf-add absolute left-[64px] top-[139px] block size-[26px] rounded-full bg-[#2950da] shadow-[0_2px_3px_rgba(25,40,57,0.18)]">
        <span className="absolute left-[7px] top-3 block h-0.5 w-3 rounded-[1px] bg-white" />
        <span className="absolute left-3 top-[7px] block h-3 w-0.5 rounded-[1px] bg-white" />
      </span>
    </span>
  );
}

function MiniTemplate({ tint }: { tint: string }) {
  return (
    <>
      <span className="absolute -left-px -top-px block h-[26px] w-[112px]" style={{ background: tint }} />
      <span className="absolute left-[11px] top-[37px] block h-1.5 w-14 rounded-[3px] bg-[#dae2ed]" />
      <span className="absolute left-[11px] top-[49px] block h-3.5 w-[88px] rounded-[3px] border border-[#dae2ed] bg-white" />
      <span className="absolute left-[11px] top-[71px] block h-1.5 w-11 rounded-[3px] bg-[#dae2ed]" />
      <span className="absolute left-[11px] top-[83px] block h-3.5 w-[88px] rounded-[3px] border border-[#dae2ed] bg-white" />
      <span className="absolute left-[59px] top-[109px] block h-3 w-10 rounded-[3px]" style={{ background: tint }} />
    </>
  );
}

/* Figma: three template cards fanned out; the side ones spread, the front one lifts and gets the selected check. */
function TemplateIllustration() {
  return (
    <span className="absolute left-1/2 top-0 block h-full w-[340px] -translate-x-1/2">
      <span className="cf-card cf-card-left absolute left-[69px] top-[42px] block h-[136px] w-[112px] overflow-hidden rounded-[8px] border border-[#dae2ed] bg-white shadow-[0_4px_12px_rgba(25,40,57,0.08)]">
        <MiniTemplate tint="#b1c1d2" />
      </span>
      <span className="cf-card cf-card-right absolute left-[157px] top-[42px] block h-[136px] w-[112px] overflow-hidden rounded-[8px] border border-[#dae2ed] bg-white shadow-[0_4px_12px_rgba(25,40,57,0.08)]">
        <MiniTemplate tint="#b4c2f2" />
      </span>
      <span className="cf-card cf-card-front absolute left-[113.5px] top-9 block h-[136px] w-[112px] overflow-hidden rounded-[8px] border border-[#dae2ed] bg-white shadow-[0_6px_16px_rgba(25,40,57,0.12)]">
        <MiniTemplate tint="#2950da" />
      </span>
      <span className="cf-badge absolute left-[210px] top-7 flex size-6 items-center justify-center rounded-full border-2 border-white bg-[#2950da] text-white shadow-[0_2px_4px_rgba(25,40,57,0.18)]">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    </span>
  );
}
