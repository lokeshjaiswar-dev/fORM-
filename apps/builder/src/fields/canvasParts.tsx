import type { CSSProperties, ReactNode } from 'react';
import { Badge, Button, Checkbox, CheckboxField, Chip, DatePicker, FileDropzone, Input, MultiSelect, RadioField, RadioGroup, RadioGroupItem, Select as DsSelect, SelectTrigger, SelectValue, Slider, Textarea, TimePicker } from '@dmacq/ui';
import { defineMessages } from '@form/i18n';
import { themeImageUrl } from '@form/renderer';
import type { BlockStyle, ChoiceOption } from '@form/schema';
import { t } from '@/i18n';
import { inputStyle, labelString } from '@/fields/style';

/* Static previews of respondent controls, using the same renderer classes as fill/preview. */

const M = defineMessages('builder', {
  'canvas.answer': 'Your answer',
  'canvas.select': 'Select…',
  'canvas.other': 'Other…',
  'canvas.rank_hint': 'Order the options with the move buttons.',
});

const controlStyle = (block?: { style?: BlockStyle }) => ({ ...inputStyle(block?.style) }) as CSSProperties;

export function TextBox({ block, placeholder, prefix, suffix, tall }: { block: { style?: BlockStyle }; placeholder?: string | undefined; prefix?: string | undefined; suffix?: string | undefined; tall?: boolean }) {
  const style = { ...controlStyle(block), backgroundColor: 'transparent' };
  if (tall) {
    return (
      <Textarea
        readOnly
        tabIndex={-1}
        className="pointer-events-none bg-transparent"
        data-canvas-input=""
        placeholder={placeholder || t(M['canvas.answer'])}
        rows={4}
        style={style}
      />
    );
  }
  return (
    <Input
      readOnly
      tabIndex={-1}
      className="pointer-events-none"
      data-canvas-input=""
      placeholder={placeholder || t(M['canvas.answer'])}
      prefixText={prefix}
      suffixText={suffix}
      style={style}
    />
  );
}

export function OptionList({
  options,
  shape,
  numbered,
  other,
  pictures,
  columns,
}: {
  options: readonly ChoiceOption[];
  shape: 'round' | 'square';
  numbered?: boolean;
  other?: boolean;
  pictures?: boolean;
  columns?: 1 | 2 | 3 | 4 | undefined;
}) {
  if (pictures) {
    return (
      <div className="fr-image-choices pointer-events-none" style={{ '--fr-columns': columns ?? 2 } as CSSProperties}>
        {options.map((opt) => {
          const src = themeImageUrl(opt.image?.assetId);
          return (
            <div key={opt.id} className="fr-image-choice">
              {shape === 'round' ? (
                <RadioGroup disabled>
                  <RadioField value={opt.id} label="" disabled />
                </RadioGroup>
              ) : (
                <CheckboxField label="" disabled />
              )}
              {src ? <img src={src} alt="" /> : <span className="fr-image-choice-fallback" />}
              <span>{labelString(opt.label)}</span>
            </div>
          );
        })}
      </div>
    );
  }
  const labels = [
    ...options.map((opt, i) => ({ id: opt.id, label: numbered ? `${i + 1}. ${labelString(opt.label)}` : labelString(opt.label) })),
    ...(other ? [{ id: '__other__', label: t(M['canvas.other']) }] : []),
  ];
  if (shape === 'round') {
    return (
      <RadioGroup className="fr-choices pointer-events-none" style={{ '--fr-columns': columns ?? 1 } as CSSProperties} disabled>
        {labels.map((opt) => (
          <RadioField key={opt.id} value={opt.id} label={opt.label} disabled />
        ))}
      </RadioGroup>
    );
  }
  return (
    <div className="fr-choices pointer-events-none" style={{ '--fr-columns': columns ?? 1 } as CSSProperties}>
      {labels.map((opt) => (
        <CheckboxField key={opt.id} label={opt.label} disabled />
      ))}
    </div>
  );
}

export function Select({ placeholder }: { block: { style?: BlockStyle }; placeholder?: string | undefined }) {
  return (
    <DsSelect>
      <SelectTrigger fullWidth className="pointer-events-none bg-transparent" data-canvas-input="" tabIndex={-1}>
        <SelectValue placeholder={placeholder || t(M['canvas.select'])} />
      </SelectTrigger>
    </DsSelect>
  );
}

export function MultiSelectBox({ placeholder }: { placeholder?: string | undefined }) {
  return <MultiSelect readOnly options={[]} value={[]} placeholder={placeholder || t(M['canvas.select'])} className="pointer-events-none bg-transparent" />;
}

export function Points({ from, to, low, high, variant = 'boxes' }: { from: number; to: number; low?: string | undefined; high?: string | undefined; variant?: 'boxes' | 'icons' }): ReactNode {
  return (
    <div className="fr-points pointer-events-none" data-variant={variant}>
      {low ? <span className="fr-point-label">{low}</span> : null}
      <div className="fr-point-row">
        {Array.from({ length: to - from + 1 }, (_, i) => (
          <span key={i} className="fr-point" aria-checked="false">
            {from + i}
          </span>
        ))}
      </div>
      {high ? <span className="fr-point-label">{high}</span> : null}
    </div>
  );
}

export function CanvasRadio() {
  return (
    <RadioGroup className="flex justify-center pointer-events-none" disabled>
      <RadioGroupItem value="preview" disabled aria-hidden tabIndex={-1} />
    </RadioGroup>
  );
}

export function CanvasCheck() {
  return <Checkbox disabled aria-hidden tabIndex={-1} className="pointer-events-none" />;
}

export function CanvasDate() {
  return <DatePicker readOnly clearable={false} className="pointer-events-none" />;
}

export function CanvasTime() {
  return <TimePicker readOnly clearable={false} className="pointer-events-none" />;
}

export function CanvasDateTime() {
  return (
    <div className="fr-range pointer-events-none">
      <CanvasDate />
      <CanvasTime />
    </div>
  );
}

export function RankingList({ options }: { options: readonly ChoiceOption[] }) {
  return (
    <div className="pointer-events-none">
      <p className="fr-hint">{t(M['canvas.rank_hint'])}</p>
      <ol className="fr-ranking">
        {options.map((opt, i) => (
          <li key={opt.id} className="fr-rank">
            <Badge appearance="subtle" size="sm" shape="circular" aria-hidden>{i + 1}</Badge>
            <span className="fr-rank-label">{labelString(opt.label)}</span>
            <Button type="button" variant="outline" size="sm" disabled tabIndex={-1} aria-hidden>
              <svg viewBox="0 0 24 24" focusable="false"><path d="M6 15l6-6 6 6" /></svg>
            </Button>
            <Button type="button" variant="outline" size="sm" disabled tabIndex={-1} aria-hidden>
              <svg viewBox="0 0 24 24" focusable="false"><path d="M6 9l6 6 6-6" /></svg>
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export { Chip, FileDropzone, Slider };
