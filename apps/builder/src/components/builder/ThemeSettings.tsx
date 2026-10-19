import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { isSafeUrl, type Ending, type EndingId, type FontId, type FormDefinition, type HexColor, type RichDoc, type ThemeColorToken } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { APP_IDS, blankDefinition, richDoc } from '@/lib/definition';
import { setBehavior, setEndings, setTheme } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { updateOps, useOpsStore } from '@/state/opsStore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NiceSelect } from '@/components/ui/select';
import { RichEditor } from '@/components/editor/RichEditor';

const M = defineMessages('builder', {
  'settings.title': 'Customize',
  'settings.description': 'Theme and form settings.',
  'settings.theme': 'Theme',
  'settings.accent': 'Buttons and links',
  'settings.page': 'Background',
  'settings.text': 'Text',
  'settings.font': 'Font',
  'settings.form': 'Form settings',
  'settings.submit': 'Submit button',
  'settings.thanks': 'Thank-you message',
  'settings.redirect': 'Redirect after submit',
  'settings.redirect_hint': 'An https address; leave empty to show the thank-you message',
  'settings.redirect_invalid': 'Use an https address',
  'settings.progress': 'Progress bar',
  'settings.confetti': 'Confetti on submit',
  'settings.closed': 'Close form',
  'settings.closed_message': 'Closed message',
  'settings.password': 'Password (optional)',
  'settings.password_hint': 'Kept in this browser for the preview; the server hashes it when forms are saved there.',
});

const PRESETS = ['#111111', '#2563eb', '#7c3aed', '#db2777', '#059669', '#ea580c'] as const;
const FONTS = [['inter', 'Inter'], ['georgia', 'Georgia'], ['mono', 'Mono']] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

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
      {open ? <SettingsContent /> : null}
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so the closed dialog never follows the document. */
function SettingsContent() {
  const def = useDoc((d) => d);
  const ops = useOpsStore();
  const tokens = def.theme.tokens;
  const message = messageEnding(def);
  const [redirect, setRedirect] = useDraft(redirectOf(def));
  const redirectValid = redirect === '' || (isSafeUrl(redirect) && /^https:/i.test(redirect));
  /* The button needs a label: an emptied field keeps the last one until the author types another. */
  const [submit, setSubmit] = useState(labelString(def.behavior.submit.label));

  const color = (token: ThemeColorToken, value: string) => {
    if (!HEX.test(value)) return;
    const colors = { ...tokens.colors, [token]: value as HexColor, ...(token === 'text' ? { inputText: value as HexColor } : {}) };
    setTheme({ ...def.theme, tokens: { ...tokens, colors } });
  };
  const setThanks = (content: RichDoc) => {
    if (!message) return;
    setEndings(def.endings.map((e) => (e.id === message.id ? { ...message, content } : e.kind === 'redirect' ? { ...e, message: content } : e)), def.defaultEndingId);
  };
  /* The behaviour flag and the message ending's confetti change together, in one undo step. */
  const setConfetti = (on: boolean) =>
    setEndings(def.endings.map((e) => (e.id === message?.id ? { ...message, confetti: on } : e)), def.defaultEndingId, { ...def.behavior, successAnimation: on });

  return (
    <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t(M['settings.title'])}</DialogTitle>
        <DialogDescription>{t(M['settings.description'])}</DialogDescription>
      </DialogHeader>
      <div className="space-y-5">
        <section className="space-y-3">
          <p className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">{t(M['settings.theme'])}</p>
          <ColorRow label={t(M['settings.accent'])} value={tokens.colors.accent} fallback="#2383e2" onChange={(v) => color('accent', v)} />
          <ColorRow label={t(M['settings.page'])} value={tokens.colors.page} fallback="#ffffff" onChange={(v) => color('page', v)} />
          <ColorRow label={t(M['settings.text'])} value={tokens.colors.text} fallback="#37352f" onChange={(v) => color('text', v)} />
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => color('accent', c)}
                className="size-7 rounded-full border-2"
                style={{ background: c, borderColor: tokens.colors.accent === c ? '#111' : 'transparent' }}
              />
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>{t(M['settings.font'])}</Label>
            <NiceSelect
              size="sm"
              value={typeof tokens.typography.body === 'string' ? tokens.typography.body : 'inter'}
              onChange={(font) => setTheme({ ...def.theme, tokens: { ...tokens, typography: { ...tokens.typography, body: font as FontId } } })}
              options={FONTS.map(([value, label]) => ({ value, label }))}
            />
          </div>
          <Toggle id="progress" label={t(M['settings.progress'])} checked={tokens.progress !== 'none'} onChange={(on) => setTheme({ ...def.theme, tokens: { ...tokens, progress: on ? 'bar' : 'none' } })} />
        </section>
        <section className="space-y-3">
          <p className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">{t(M['settings.form'])}</p>
          <div className="space-y-1.5">
            <Label htmlFor="submit-label">{t(M['settings.submit'])}</Label>
            <Input
              id="submit-label"
              value={submit}
              onChange={(e) => {
                setSubmit(e.target.value);
                if (e.target.value.trim()) setBehavior({ ...def.behavior, submit: { ...def.behavior.submit, label: e.target.value } });
              }}
            />
          </div>
          {message ? (
            <div className="space-y-1.5">
              <Label>{t(M['settings.thanks'])}</Label>
              <div className="rounded-md border border-zinc-200 px-2">
                <RichEditor value={message.content} onChange={setThanks} className="text-sm leading-6" placeholder={t(M['settings.thanks'])} />
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="redirect">{t(M['settings.redirect'])}</Label>
            <Input
              id="redirect"
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
            <p className={redirectValid ? 'text-[12px] text-[var(--notion-text-muted)]' : 'text-[12px] text-[#eb5757]'}>
              {t(redirectValid ? M['settings.redirect_hint'] : M['settings.redirect_invalid'])}
            </p>
          </div>
          <Toggle id="successAnimation" label={t(M['settings.confetti'])} checked={def.behavior.successAnimation} onChange={setConfetti} />
          <Toggle id="closed" label={t(M['settings.closed'])} checked={!ops.open} onChange={(closed) => updateOps({ open: !closed })} />
          {!ops.open ? (
            <div className="space-y-1.5">
              <Label>{t(M['settings.closed_message'])}</Label>
              <div className="rounded-md border border-zinc-200 px-2">
                <RichEditor value={ops.closedMessage.content.length ? ops.closedMessage : richDoc('')} onChange={(closedMessage) => updateOps({ closedMessage })} className="text-sm leading-6" />
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="password">{t(M['settings.password'])}</Label>
            <Input id="password" type="password" value={ops.password} onChange={(e) => updateOps({ password: e.target.value.slice(0, 200) })} />
            <p className="text-[12px] text-[var(--notion-text-muted)]">{t(M['settings.password_hint'])}</p>
          </div>
        </section>
      </div>
    </DialogContent>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label htmlFor={id}>{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ColorRow({ label, value, fallback, onChange }: { label: string; value: unknown; fallback: string; onChange: (v: string) => void }) {
  const hex = typeof value === 'string' && HEX.test(value) ? value : fallback;
  const [text, setText] = useDraft(hex);
  return (
    <div className="flex items-center justify-between gap-3">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value)} className="size-8 cursor-pointer rounded" />
        <Input
          className="w-28"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
          }}
        />
      </div>
    </div>
  );
}
