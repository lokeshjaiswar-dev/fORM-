import { defineMessages } from '@form/i18n';
import { FORM_TITLE_WEIGHTS, type FormTitleStyle, type FormTitleWeight, type HexColor } from '@form/schema';
import { TITLE_SECTION_ID } from '@form/renderer';
import { t } from '@/i18n';
import { setTitleStyle } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Field, SectionTitle, SelectField } from '@/components/builder/inspector/parts';
import { Input, Label, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';

const M = defineMessages('builder', {
  'inspector.form_title_type': 'Form title',
  'inspector.form_title_look': 'Title look',
  'inspector.form_title_text_color': 'Title colour',
  'inspector.form_title_size': 'Title size',
  'inspector.form_title_size_hint': 'Empty uses the theme default.',
  'inspector.form_title_align': 'Alignment',
  'inspector.form_title_align_left': 'Left',
  'inspector.form_title_align_center': 'Center',
  'inspector.form_title_align_right': 'Right',
  'inspector.form_title_weight': 'Weight',
  'inspector.form_title_weight_normal': 'Normal',
  'inspector.form_title_weight_medium': 'Medium',
  'inspector.form_title_weight_semibold': 'Semibold',
  'inspector.form_title_weight_bold': 'Bold',
  'inspector.form_title_theme_hint': 'Empty colours use the form theme (Text in form settings).',
  'inspector.color_code': '{label} hex code',
});

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ label, value, fallback, onChange }: { label: string; value: HexColor | undefined; fallback: string; onChange: (v: HexColor | undefined) => void }) {
  const hex = typeof value === 'string' && HEX.test(value) ? value : fallback;
  return (
    <div className="flex min-h-8 items-center justify-between gap-2">
      <Label className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{label}</Label>
      <div className="flex shrink-0 items-center gap-1.5">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value as HexColor)} className="size-7 shrink-0 cursor-pointer rounded border border-border" />
        <Input
          className="h-7 w-[92px] px-2 text-[12px]"
          aria-label={t(M['inspector.color_code'], { label })}
          defaultValue={typeof value === 'string' ? value : ''}
          key={value ?? 'empty'}
          placeholder={fallback}
          onChange={(e) => {
            const next = e.target.value.trim();
            if (!next) onChange(undefined);
            else if (HEX.test(next)) onChange(next as HexColor);
          }}
        />
      </div>
    </div>
  );
}

const weightLabel = (weight: FormTitleWeight): string => t(M[`inspector.form_title_weight_${weight}`]);

export function TitleInspector() {
  const style = useDoc((d) => d.titleStyle) ?? {};
  const set = (patch: Partial<FormTitleStyle>) => setTitleStyle(patch);

  return (
    <div className="space-y-4">
      <SectionTitle>{t(M['inspector.form_title_look'])}</SectionTitle>
      <p className="text-[12px] text-muted-foreground">{t(M['inspector.form_title_theme_hint'])}</p>
      <ColorField label={t(M['inspector.form_title_text_color'])} value={style.textColor} fallback="#111111" onChange={(textColor) => set({ textColor })} />
      <Field label={t(M['inspector.form_title_size'])} hint={t(M['inspector.form_title_size_hint'])}>
        <Input
          type="number"
          min={20}
          max={72}
          className="h-8"
          value={style.sizePx ?? ''}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (!raw) set({ sizePx: undefined });
            else {
              const sizePx = Number(raw);
              if (Number.isFinite(sizePx)) set({ sizePx: Math.min(72, Math.max(20, Math.round(sizePx))) });
            }
          }}
        />
      </Field>
      <Field label={t(M['inspector.form_title_align'])}>
        <ToggleGroup
          type="single"
          size="sm"
          appearance="tinted"
          className="w-full"
          aria-label={t(M['inspector.form_title_align'])}
          value={style.align ?? 'left'}
          onValueChange={(a) => a && set({ align: a === 'left' ? undefined : (a as FormTitleStyle['align']) })}
        >
          <ToggleGroupItem value="left" className="flex-1">{t(M['inspector.form_title_align_left'])}</ToggleGroupItem>
          <ToggleGroupItem value="center" className="flex-1">{t(M['inspector.form_title_align_center'])}</ToggleGroupItem>
          <ToggleGroupItem value="right" className="flex-1">{t(M['inspector.form_title_align_right'])}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <SelectField
        label={t(M['inspector.form_title_weight'])}
        value={style.weight ?? 'bold'}
        options={FORM_TITLE_WEIGHTS.map((value) => ({ value, label: weightLabel(value) }))}
        onChange={(weight) => set({ weight: weight === 'bold' ? undefined : (weight as FormTitleWeight) })}
      />
    </div>
  );
}

export { TITLE_SECTION_ID as TITLE_INSPECTOR_ID };
