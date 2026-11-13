import { defineMessages } from '@form/i18n';
import {
  DEFAULT_SECTION_NAV,
  SUBMIT_BUTTON_SHAPES,
  SUBMIT_BUTTON_SIZES,
  type Behavior,
  type HexColor,
  type SubmitButtonShape,
  type SubmitButtonSize,
} from '@form/schema';
import { SUBMIT_SECTION_ID } from '@form/renderer';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { labelString } from '@/fields/style';
import { setBehavior } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Field, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { ToggleGroup, ToggleGroupItem, Input, Label } from '@dmacq/ui';

const M = defineMessages('builder', {
  'inspector.submit_type': 'Submit button',
  'inspector.submit_label': 'Button label',
  'inspector.submit_align': 'Alignment',
  'inspector.submit_align_left': 'Left',
  'inspector.submit_align_center': 'Center',
  'inspector.submit_align_right': 'Right',
  'inspector.submit_align_full': 'Full width',
  'inspector.submit_look': 'Button look',
  'inspector.submit_bg': 'Background colour',
  'inspector.submit_text_color': 'Label colour',
  'inspector.submit_size': 'Size',
  'inspector.submit_size_sm': 'Small',
  'inspector.submit_size_md': 'Medium',
  'inspector.submit_size_lg': 'Large',
  'inspector.submit_shape': 'Shape',
  'inspector.submit_shape_square': 'Square',
  'inspector.submit_shape_rounded': 'Rounded',
  'inspector.submit_shape_pill': 'Pill',
  'inspector.submit_theme_hint': 'Empty colours use the form theme (Buttons in form settings).',
  'inspector.submit_nav': 'Section navigator',
  'inspector.section_include_submit': 'Include a Submit step',
  'inspector.section_submit_label': 'Submit step label',
  'inspector.color_code': '{label} hex code',
  'form.submit_label': 'Submit',
});

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ label, value, fallback, onChange }: { label: string; value: HexColor | undefined; fallback: string; onChange: (v: HexColor | undefined) => void }) {
  const hex = typeof value === 'string' && HEX.test(value) ? value : fallback;
  const [text, setText] = useDraft(typeof value === 'string' ? value : '');
  return (
    <div className="flex min-h-8 items-center justify-between gap-2">
      <Label className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{label}</Label>
      <div className="flex shrink-0 items-center gap-1.5">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value as HexColor)} className="size-7 shrink-0 cursor-pointer rounded border border-border" />
        <Input
          className="h-7 w-[92px] px-2 text-[12px]"
          aria-label={t(M['inspector.color_code'], { label })}
          value={text}
          placeholder={fallback}
          onChange={(e) => {
            setText(e.target.value);
            const next = e.target.value.trim();
            if (!next) onChange(undefined);
            else if (HEX.test(next)) onChange(next as HexColor);
          }}
        />
      </div>
    </div>
  );
}

export function SubmitInspector() {
  const behavior = useDoc((d) => d.behavior);
  const nav = useDoc((d) => d.behavior.sectionNav);
  const sectionNavOn = nav?.enabled === true;
  const submit = behavior.submit;
  const [label, setLabel] = useDraft(labelString(submit.label));

  const setSubmit = (patch: Partial<Behavior['submit']>) => {
    setBehavior({ ...behavior, submit: { ...submit, ...patch } });
  };

  const patchNav = (patch: Partial<NonNullable<Behavior['sectionNav']>>) => {
    setBehavior({
      ...behavior,
      sectionNav: { ...DEFAULT_SECTION_NAV, ...behavior.sectionNav, ...patch },
    });
  };

  return (
    <div className="space-y-4">
      <TextField
        label={t(M['inspector.submit_label'])}
        value={label}
        onChange={(v) => {
          setLabel(v);
          if (v.trim()) setSubmit({ label: v });
        }}
        onBlur={() => {
          if (label.trim()) return;
          const fallback = t(M['form.submit_label']);
          setLabel(fallback);
          setSubmit({ label: fallback });
        }}
      />
      <Field label={t(M['inspector.submit_align'])}>
        <ToggleGroup
          type="single"
          size="sm"
          appearance="tinted"
          className="w-full"
          aria-label={t(M['inspector.submit_align'])}
          value={submit.align}
          onValueChange={(a) => a && setSubmit({ align: a as Behavior['submit']['align'] })}
        >
          <ToggleGroupItem value="left" className="flex-1">{t(M['inspector.submit_align_left'])}</ToggleGroupItem>
          <ToggleGroupItem value="center" className="flex-1">{t(M['inspector.submit_align_center'])}</ToggleGroupItem>
          <ToggleGroupItem value="right" className="flex-1">{t(M['inspector.submit_align_right'])}</ToggleGroupItem>
          <ToggleGroupItem value="full" className="flex-1">{t(M['inspector.submit_align_full'])}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <SectionTitle>{t(M['inspector.submit_look'])}</SectionTitle>
      <p className="text-[12px] text-muted-foreground">{t(M['inspector.submit_theme_hint'])}</p>
      <ColorField label={t(M['inspector.submit_bg'])} value={submit.bgColor} fallback="#2563eb" onChange={(bgColor) => setSubmit({ bgColor })} />
      <ColorField label={t(M['inspector.submit_text_color'])} value={submit.textColor} fallback="#ffffff" onChange={(textColor) => setSubmit({ textColor })} />
      <SelectField
        label={t(M['inspector.submit_size'])}
        value={submit.size ?? 'md'}
        options={SUBMIT_BUTTON_SIZES.map((value) => ({ value, label: t(M[`inspector.submit_size_${value}`]) }))}
        onChange={(size) => setSubmit({ size: size === 'md' ? undefined : (size as SubmitButtonSize) })}
      />
      <SelectField
        label={t(M['inspector.submit_shape'])}
        value={submit.shape ?? 'rounded'}
        options={SUBMIT_BUTTON_SHAPES.map((value) => ({ value, label: t(M[`inspector.submit_shape_${value}`]) }))}
        onChange={(shape) => setSubmit({ shape: shape === 'rounded' ? undefined : (shape as SubmitButtonShape) })}
      />
      {sectionNavOn ? (
        <Field label={t(M['inspector.submit_nav'])}>
          <div className="space-y-3">
            <ToggleRow
              label={t(M['inspector.section_include_submit'])}
              checked={(nav ?? DEFAULT_SECTION_NAV).includeSubmit !== false}
              onChange={(includeSubmit) => patchNav({ includeSubmit })}
            />
            {(nav ?? DEFAULT_SECTION_NAV).includeSubmit !== false ? (
              <TextField
                label={t(M['inspector.section_submit_label'])}
                value={nav?.submitLabel ?? ''}
                onChange={(submitLabel) => patchNav({ submitLabel: submitLabel.trim() ? submitLabel : undefined })}
              />
            ) : null}
          </div>
        </Field>
      ) : null}
    </div>
  );
}

/** Sentinel id: opening the block settings panel for the canvas submit control. */
export { SUBMIT_SECTION_ID as SUBMIT_INSPECTOR_ID };
