import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { cn } from '@/lib/utils';
import { Field as DsField, Input, Label, Switch, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { NiceSelect, type SelectOption } from '@/components/NiceSelect';
import { Tooltip } from '@/components/Tooltip';

/* Inspector controls: each writes through a builder action as the author types, so every edit is one command. */

const M = defineMessages('builder', {
  'inspector.invalid_value': '‘{text}’ is not a valid value here',
  'inspector.more_info': 'More information about {label}',
});

/*
 * Help text lives behind an (i) icon in the label row, so the panel stays easy to scan: authors who need the
 * explanation hover or focus the icon. Only `note` stays on screen, for short live messages (what will change now).
 */

export function Field({ label, error, hint, note, htmlFor, children }: { label: string; error?: string | null | undefined; hint?: string | undefined; note?: string | undefined; htmlFor?: string; children: ReactNode }) {
  return (
    <DsField label={label} error={error ?? undefined} info={hint} hint={note} {...(htmlFor ? { htmlFor } : {})}>
      {children}
    </DsField>
  );
}

/* Section headings (OPTIONS, CUSTOMIZATION, ADVANCED, PRIVACY) read like the Toolbox categories (COMMON, CHOICES):
   11/16 semibold capitals, 0.06em apart, in the muted text colour. */
const HEADING = 'text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-muted-foreground';

/**
 * One group of settings in a panel tab (Figma 5356:184219): a full-width band with a divider under it, 16px in from
 * the edges and 20px above and below (16px above the first, untitled group). A group whose content renders nothing is
 * hidden, divider and all.
 */
export function InspectorSection({ title, collapsible, children }: { title?: string; collapsible?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsible);
  const bodyId = useId();
  return (
    <section className="border-b border-border-default px-4 py-5 first:pt-4 has-[>[data-section-body]:empty]:hidden">
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
            <ChevronDown aria-hidden className={cn('size-4 transition-transform duration-150', open && 'rotate-180')} />
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

/**
 * Settings folded behind one heading row inside a section, in the same style as a collapsible section heading. It
 * opens on its own when one of its settings is in use, so nothing switched on is ever out of sight.
 */
export function Disclosure({ title, inUse = false, children }: { title: string; inUse?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(inUse);
  const bodyId = useId();
  return (
    <div className="!mt-5 border-t border-dashed border-border pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className={cn(HEADING, 'flex w-full items-center justify-between rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring')}
      >
        {title}
        <ChevronDown aria-hidden className={cn('size-4 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open ? (
        <div id={bodyId} className="mt-4 space-y-4">
          {children}
        </div>
      ) : null}
    </div>
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

/** The (i) next to a setting: its explanation, on hover or keyboard focus. */
export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip content={text} side="top" delay={150}>
      <button
        type="button"
        aria-label={t(M['inspector.more_info'], { label })}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <CircleHelp aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}

export function ToggleRow({ label, checked, onChange, hint, note, disabled }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The explanation, shown from the (i) icon. */
  hint?: string | undefined;
  /** A short live message that stays on screen (one line). */
  note?: string | undefined;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="min-w-0 flex-1">{label}</Label>
        {hint ? <InfoTip label={label} text={hint} /> : null}
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
      {note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
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

/*
 * The settings panels' segmented bar (Figma toolbar in the panel frame, 5356:184230): a 6px-corner frame with the
 * stronger border, no inner padding, a divider between segments and 12px medium text, 32px tall. A pressed segment is
 * the light blue fill alone, without the design system's inner ring, which read as a second border inside the frame.
 * Every segmented choice in the panels (block width, alignment, field type, API method and format, true / false)
 * uses this pair, so they look the same everywhere.
 */
const SEGMENTED = 'w-full overflow-hidden border-border-default p-0 shadow-none divide-x divide-border-default';
const SEGMENT = 'flex-1 rounded-none text-[12px] font-medium leading-4 data-[state=on]:inset-ring-0';

export function SegmentedGroup({ className, ...props }: ComponentProps<typeof ToggleGroup>) {
  return <ToggleGroup size="md" appearance="tinted" {...props} className={cn(SEGMENTED, className)} />;
}

export function Segment({ className, ...props }: ComponentProps<typeof ToggleGroupItem>) {
  return <ToggleGroupItem {...props} className={cn(SEGMENT, className)} />;
}
