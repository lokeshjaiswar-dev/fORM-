import { useId, type ReactNode } from 'react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NiceSelect, type SelectOption } from '@/components/ui/select';

/* Inspector controls: each writes through a builder action as the author types, so every edit is one command. */

const M = defineMessages('builder', {
  'inspector.invalid_value': '‘{text}’ is not a valid value here',
});

export function Field({ label, error, hint, htmlFor, children }: { label: string; error?: string | null | undefined; hint?: string | undefined; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-[12px] text-[var(--notion-text-muted)]">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[12px] text-[var(--notion-text-muted)]">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-[12px] text-[#eb5757]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{children}</p>;
}

export function TextField({ label, value, onChange, placeholder, error, hint }: {
  label: string; value: string | undefined; onChange: (value: string) => void; placeholder?: string; error?: string | null | undefined; hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      <Input id={id} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/**
 * A number typed as text: it is written only when it parses (`parse` returns null otherwise), so a half-typed value
 * never reaches the document; an empty field writes `undefined`.
 */
export function NumberField<T>({ label, value, onChange, parse, format = String, placeholder, error, hint }: {
  label: string;
  value: T | undefined;
  onChange: (value: T | undefined) => void;
  parse: (text: string) => T | null;
  format?: (value: T) => string;
  placeholder?: string;
  error?: string | null | undefined;
  hint?: string;
}) {
  const id = useId();
  const shown = value === undefined ? '' : format(value);
  const [text, setText] = useDraft(shown);
  const parsed = text.trim() === '' ? undefined : parse(text.trim());
  return (
    <Field label={label} error={parsed === null ? t(M['inspector.invalid_value'], { text }) : error} hint={hint} htmlFor={id}>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const raw = e.target.value.trim();
          if (raw === '') onChange(undefined);
          else {
            const next = parse(raw);
            if (next !== null) onChange(next);
          }
        }}
      />
    </Field>
  );
}

export function ToggleRow({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
      {hint ? <p className="text-[12px] text-[var(--notion-text-muted)]">{hint}</p> : null}
    </div>
  );
}

export function SelectField({ label, value, options, onChange, placeholder }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <NiceSelect size="sm" value={value} onChange={onChange} options={options} {...(placeholder !== undefined ? { placeholder } : {})} />
    </Field>
  );
}
