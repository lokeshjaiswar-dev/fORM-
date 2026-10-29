import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type Ending, type EndingId, type FormDefinition, type RichDoc } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { APP_IDS, blankDefinition, richDoc } from '@/lib/definition';
import { setBehavior, setEndings } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { updateOps, useOpsStore } from '@/state/opsStore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Switch } from '@dmacq/ui';
import { RichEditor } from '@/components/editor/RichEditor';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'settings.title': 'Customize',
  'settings.description': 'Theme and form settings.',
  'settings.form': 'Form settings',
  'settings.submit': 'Submit button',
  'settings.thanks': 'Thank-you message',
  'settings.redirect': 'Redirect after submit',
  'settings.redirect_hint': 'An https address; leave empty to show the thank-you message',
  'settings.redirect_invalid': 'Use an https address',
  'settings.confetti': 'Confetti on submit',
  'settings.closed': 'Close form',
  'settings.closed_message': 'Closed message',
  'settings.password': 'Password (optional)',
  'settings.password_hint': 'Kept in this browser for the preview; the server hashes it when forms are saved there.',
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

/** Submit, ending, close and optional password. Empty password means none. */
export function SubmissionSettings({ dark = false }: { dark?: boolean }) {
  const def = useDoc((d) => d);
  const ops = useOpsStore();
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

  const field = dark ? 'border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground' : undefined;
  const labelCls = dark ? 'text-sidebar-foreground/80' : undefined;
  const hintCls = redirectValid ? 'text-[12px] text-muted-foreground' : 'text-[12px] text-destructive';

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="submit-label" className={labelCls}>{t(M['settings.submit'])}</Label>
        <Input
          id="submit-label"
          className={field}
          value={submit}
          onChange={(e) => {
            setSubmit(e.target.value);
            if (e.target.value.trim()) setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: e.target.value } });
          }}
        />
      </div>
      {message ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['settings.thanks'])}</Label>
          <div className={cn('rounded-md border px-2', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border')}>
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
      <Toggle dark={dark} id="successAnimation" label={t(M['settings.confetti'])} checked={def.behavior.successAnimation} onChange={setConfetti} />
      <Toggle dark={dark} id="closed" label={t(M['settings.closed'])} checked={!ops.open} onChange={(closed) => updateOps({ open: !closed })} />
      {!ops.open ? (
        <div className="space-y-1.5">
          <Label className={labelCls}>{t(M['settings.closed_message'])}</Label>
          <div className={cn('rounded-md border px-2', dark ? 'border-sidebar-border bg-sidebar-accent/40' : 'border-border')}>
            <RichEditor value={ops.closedMessage.content.length ? ops.closedMessage : richDoc('')} onChange={(closedMessage) => updateOps({ closedMessage })} className="text-sm leading-6" />
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="password" className={labelCls}>{t(M['settings.password'])}</Label>
        <Input id="password" type="password" autoComplete="new-password" className={field} value={ops.password} placeholder="" onChange={(e) => updateOps({ password: e.target.value.slice(0, 200) })} />
        <p className="text-[12px] text-muted-foreground">{t(M['settings.password_hint'])}</p>
      </div>
    </div>
  );
}

function Toggle({ id, label, checked, onChange, dark }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; dark?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className={dark ? 'text-sidebar-foreground/80' : undefined}>{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

