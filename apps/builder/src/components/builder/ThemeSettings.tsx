import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type ConfettiStyle, type Ending, type EndingId, type FormDefinition, type RichDoc } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { APP_IDS, blankDefinition } from '@/lib/definition';
import { setBehavior, setEndings } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Switch } from '@dmacq/ui';
import { AccessPanel } from '@/components/builder/access/AccessPanel';
import { RichEditor } from '@/components/editor/RichEditor';
import { NiceSelect } from '@/components/NiceSelect';
import { InspectorSection } from '@/components/builder/inspector/parts';

const CONFETTI_STYLES: ConfettiStyle[] = ['classic', 'pastel', 'ocean', 'sunset'];
const CONFETTI_LABEL: Record<ConfettiStyle, 'settings.confetti_classic' | 'settings.confetti_pastel' | 'settings.confetti_ocean' | 'settings.confetti_sunset'> = {
  classic: 'settings.confetti_classic',
  pastel: 'settings.confetti_pastel',
  ocean: 'settings.confetti_ocean',
  sunset: 'settings.confetti_sunset',
};

const M = defineMessages('builder', {
  'settings.title': 'Customize',
  'settings.description': 'Theme and form settings.',
  'settings.form': 'Form settings',
  'settings.submit': 'Submit button',
  'settings.section_button': 'Button',
  'settings.section_after': 'After submitting',
  'settings.thanks': 'Thank-you message',
  'settings.redirect': 'Redirect after submit',
  'settings.redirect_hint': 'An https address; leave empty to show the thank-you message',
  'settings.redirect_invalid': 'Use an https address',
  'settings.confetti': 'Confetti on submit',
  'settings.confetti_style': 'Confetti style',
  'settings.confetti_classic': 'Classic',
  'settings.confetti_pastel': 'Hearts',
  'settings.confetti_ocean': 'Ocean',
  'settings.confetti_sunset': 'Crackers',
  'form.submit_label': 'Submit',
});

type MessageEnding = Extract<Ending, { kind: 'message' }>;

const messageEnding = (def: FormDefinition): MessageEnding | undefined => def.endings.find((e): e is MessageEnding => e.kind === 'message');

/** The redirect URL of the default ending, when it is a plain https redirect. */
const redirectOf = (def: FormDefinition): string => {
  const ending = def.endings.find((e) => e.id === def.defaultEndingId);
  return ending?.kind === 'redirect' ? labelString(ending.url) : '';
};

/**
 * Endings with `url` as the default redirect. An empty url removes it and the message ending is the default again; a
 * form that has none gets the blank form's thank-you message.
 */
function withRedirect(def: FormDefinition, url: string): { endings: Ending[]; defaultEndingId: EndingId } {
  const message = messageEnding(def);
  const others = def.endings.filter((e) => e.kind !== 'redirect' || e.id !== def.defaultEndingId);
  if (!url) {
    if (message) return { endings: others, defaultEndingId: message.id };
    const thanks = { ...(messageEnding(blankDefinition(def.formId)) as MessageEnding), id: APP_IDS.newId() as EndingId };
    return { endings: [...others, thanks], defaultEndingId: thanks.id };
  }
  const current = def.endings.find((e) => e.id === def.defaultEndingId && e.kind === 'redirect');
  const id = (current?.id ?? APP_IDS.newId()) as EndingId;
  const redirect: Ending = { id, kind: 'redirect', name: t(M['settings.redirect']), url: [url], ...(message ? { message: message.content } : {}) };
  return { endings: [...others, redirect], defaultEndingId: id };
}

export function ThemeSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(M['settings.title'])}</DialogTitle>
            <DialogDescription>{t(M['settings.description'])}</DialogDescription>
          </DialogHeader>
          <SubmissionSettings />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Submit button, thank-you message, redirect and confetti (the form's definition), then the Access section: who may open
 * the form and when, its password and its address (FormOps on the server, WP-1.07). Laid out as the settings panel's
 * sections (Button, After submitting, Access).
 */
export function SubmissionSettings() {
  const def = useDoc((d) => d);
  const message = messageEnding(def);
  const [redirect, setRedirect] = useDraft(redirectOf(def));
  const redirectValid = redirect === '' || (isSafeUrl(redirect) && /^https:/i.test(redirect));
  /* The button needs a label: an emptied field keeps the last one until the author types another. */
  const [submit, setSubmit] = useState(labelString(def.behavior.submit.label));

  const setThanks = (content: RichDoc) => {
    if (!message) return;
    setEndings(def.endings.map((e) => (e.id === message.id ? { ...message, content } : e.kind === 'redirect' ? { ...e, message: content } : e)), def.defaultEndingId);
  };
  /* The behaviour flag and the message ending's confetti change together, in one undo step. */
  const setConfetti = (on: boolean) =>
    setEndings(def.endings.map((e) => (e.id === message?.id ? { ...message, confetti: on } : e)), def.defaultEndingId, { ...def.behavior, successAnimation: on });

  const field = undefined;
  const labelCls = undefined;
  const hintCls = redirectValid ? 'text-[12px] text-muted-foreground' : 'text-[12px] text-destructive';

  return (
    <>
      <InspectorSection title={t(M['settings.section_button'])}>
      <div className="space-y-1.5">
        <Label htmlFor="submit-label" className={labelCls}>{t(M['settings.submit'])}</Label>
        <Input
          id="submit-label"
          className={field}
          value={submit}
          onChange={(e) => {
            const v = e.target.value;
            setSubmit(v);
            if (v.trim()) setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: v } });
          }}
          onBlur={() => {
            if (submit.trim()) return;
            const fallback = t(M['form.submit_label']);
            setSubmit(fallback);
            setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: fallback } });
          }}
        />
      </div>
      </InspectorSection>
      <InspectorSection title={t(M['settings.section_after'])}>
      {message ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['settings.thanks'])}</Label>
          <div className="ds-field block px-2 py-1">
            <RichEditor value={message.content} onChange={setThanks} className="text-sm leading-6" placeholder={t(M['settings.thanks'])} />
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="redirect" className={labelCls}>{t(M['settings.redirect'])}</Label>
        <Input
          id="redirect"
          className={field}
          value={redirect}
          placeholder="https://…"
          onChange={(e) => {
            const url = e.target.value.trim();
            setRedirect(e.target.value);
            if (url === '' || (isSafeUrl(url) && /^https:/i.test(url))) {
              const next = withRedirect(def, url);
              setEndings(next.endings, next.defaultEndingId);
            }
          }}
        />
        <p className={hintCls}>{t(redirectValid ? M['settings.redirect_hint'] : M['settings.redirect_invalid'])}</p>
      </div>
      <Toggle id="successAnimation" label={t(M['settings.confetti'])} checked={def.behavior.successAnimation} onChange={setConfetti} />
      {def.behavior.successAnimation && message ? (
        <div className="space-y-1.5">
          <Label htmlFor="confetti-style" className={labelCls}>{t(M['settings.confetti_style'])}</Label>
          <NiceSelect
            value={message.confettiStyle ?? 'classic'}
            onChange={(v) => setEndings(def.endings.map((e) => (e.id === message.id ? { ...message, confettiStyle: v as ConfettiStyle } : e)), def.defaultEndingId)}
            options={CONFETTI_STYLES.map((s) => ({ value: s, label: t(M[CONFETTI_LABEL[s]]) }))}
            aria-label={t(M['settings.confetti_style'])}
          />
        </div>
      ) : null}
      </InspectorSection>
      <InspectorSection>
        <AccessPanel />
      </InspectorSection>
    </>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id}>{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

