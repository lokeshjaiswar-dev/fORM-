import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { cn } from '@/lib/utils';
import { Field as DsField, Input, Label, Switch } from '@dmacq/ui';
import { NiceSelect, type SelectOption } from '@/components/NiceSelect';

/* Inspector controls: each writes through a builder action as the author types, so every edit is one command. */

const M = defineMessages('builder', {
  'inspector.invalid_value': '‘{text}’ is not a valid value here',
});

export function Field({ label, error, hint, htmlFor, children }: { label: string; error?: string | null | undefined; hint?: string | undefined; htmlFor?: string; children: ReactNode }) {
  return (
    <DsField label={label} error={error ?? undefined} hint={hint} {...(htmlFor ? { htmlFor } : {})}>
      {children}
    </DsField>
  );
}

const HEADING = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

/**
 * One group of settings in a panel tab. Groups stack with a divider between them (none above the first), so authors
 * can see which settings belong together. A group whose content renders nothing is hidden, divider and all.
 */
export function InspectorSection({ title, collapsible, children }: { title?: string; collapsible?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsible);
  const bodyId = useId();
  return (
    <section className="border-t border-border py-5 first:border-t-0 first:pt-1 last:pb-1 has-[>[data-section-body]:empty]:hidden">
      {title && collapsible ? (
        /* Folded by default: settings an author rarely needs stay one click away instead of filling the panel. */
        <h3 className={open ? 'mb-4' : undefined}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
            className={cn(HEADING, 'flex w-full items-center justify-between rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring')}
          >
            {title}
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} />
          </button>
        </h3>
      ) : title ? (
        <h3 className={cn(HEADING, 'mb-4')}>{title}</h3>
      ) : null}
      {/* A folded section keeps a placeholder body so the empty-section rule above does not hide its heading. */}
      <div data-section-body id={bodyId} className="space-y-4" hidden={!open}>
        {open ? children : <span hidden />}
      </div>
    </section>
  );
}

/** A sub-group inside a section: a divider and a heading, for the groups a field type's own settings define. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className={cn(HEADING, '!mt-5 border-t border-dashed border-border pt-4 first:!mt-0 first:border-t-0 first:pt-0')}>{children}</h4>;
}

export function TextField({ label, value, onChange, onBlur, placeholder, error, hint }: {
  label: string; value: string | undefined; onChange: (value: string) => void; onBlur?: () => void; placeholder?: string; error?: string | null | undefined; hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      <Input id={id} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
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
      {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SelectField({ label, value, options, onChange, placeholder }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <NiceSelect size="sm" value={value} onChange={onChange} options={options} aria-label={label} {...(placeholder !== undefined ? { placeholder } : {})} />
    </Field>
  );
}
