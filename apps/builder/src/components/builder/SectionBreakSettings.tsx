import { defineMessages } from '@form/i18n';
import {
  DEFAULT_SECTION_NAV,
  SECTION_NAV_CHROMES,
  SECTION_NAV_CONNECTORS,
  SECTION_NAV_CURRENT,
  type HexColor,
  type SectionNav,
} from '@form/schema';
import { t } from '@/i18n';
import { setBehavior } from '@/state/actions';
import { currentDoc, useDoc } from '@/state/documentStore';
import { Input, Label, Switch } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import { useDraft } from '@/lib/useDraft';
import { applyPatch, type Patch } from '@/lib/patch';

const M = defineMessages('builder', {
  'sections.enable': 'Section break',
  'sections.enable_hint': 'Named markers and a navigator. Palette then shows a Section break field for the title.',
  'sections.mode': 'Behaviour',
  'sections.mode_scroll': 'Single page (scroll to section)',
  'sections.mode_paged': 'Break the page',
  'sections.label_size': 'Label size',
  'sections.label_color': 'Label colour',
  'sections.color': 'Section colour',
  'sections.shape': 'Shape',
  'sections.size': 'Size',
  'sections.connector': 'Icon between sections',
  'sections.position': 'Position',
  'sections.current': 'Current section',
  'sections.align': 'Align',
  'sections.submit': 'Include Submit',
  'sections.size_sm': 'Small',
  'sections.size_md': 'Medium',
  'sections.size_lg': 'Large',
  'sections.chrome_plain': 'Plain',
  'sections.chrome_cards': 'Cards',
  'sections.chrome_circles': 'Circles',
  'sections.chrome_bar': 'Bar',
  'sections.connector_arrow': 'Arrow',
  'sections.connector_line': 'Line',
  'sections.connector_chevron': 'Chevron',
  'sections.connector_none': 'None',
  'sections.placement_top': 'Top',
  'sections.placement_bottom': 'Bottom',
  'sections.current_color': 'Colour',
  'sections.current_fill': 'Fill',
  'sections.current_pulse': 'Pulse',
  'sections.current_underline': 'Underline',
  'sections.current_bold': 'Bold',
  'sections.align_start': 'Start',
  'sections.align_center': 'Centre',
  'sections.align_end': 'End',
});

function patchNav(patch: Patch<SectionNav>): void {
  const doc = currentDoc();
  setBehavior({ ...doc.behavior, sectionNav: applyPatch({ ...DEFAULT_SECTION_NAV, ...doc.behavior.sectionNav }, patch) });
}

export function SectionBreakSettings() {
  const nav = useDoc((d) => d.behavior.sectionNav);
  const enabled = nav?.enabled === true;
  const current = { ...DEFAULT_SECTION_NAV, ...nav };
  const position = current.placement === 'bottom' || current.placement.startsWith('bottom_') ? 'bottom' : 'top';
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="section-nav-enabled" className="text-sidebar-foreground">{t(M['sections.enable'])}</Label>
          <p className="mt-1 text-[12px] leading-5 text-sidebar-muted">{t(M['sections.enable_hint'])}</p>
        </div>
        <Switch
          id="section-nav-enabled"
          checked={enabled}
          onCheckedChange={(on) => patchNav({ enabled: on })}
          aria-label={t(M['sections.enable'])}
        />
      </div>
      {enabled ? (
        <>
          <SelectRow
            label={t(M['sections.mode'])}
            value={current.mode ?? 'scroll'}
            options={[
              ['scroll', t(M['sections.mode_scroll'])],
              ['paged', t(M['sections.mode_paged'])],
            ]}
            onChange={(mode) => patchNav({ mode: mode as SectionNav['mode'] })}
          />
          {current.mode === 'scroll' ? (
            <>
              <NumberRow
                label={t(M['sections.label_size'])}
                value={current.labelSizePx ?? 14}
                min={10}
                max={32}
                onChange={(labelSizePx) => patchNav({ labelSizePx })}
              />
              <ColorRow label={t(M['sections.label_color'])} value={current.labelColor} fallback="#52525b" onChange={(labelColor) => patchNav({ labelColor })} />
            </>
          ) : null}
          <ColorRow label={t(M['sections.color'])} value={current.color} fallback="#2563eb" onChange={(color) => patchNav({ color })} />
          <SelectRow
            label={t(M['sections.shape'])}
            value={current.chrome ?? 'cards'}
            options={SECTION_NAV_CHROMES.map((value) => [value, t(M[`sections.chrome_${value}`])])}
            onChange={(chrome) => patchNav({ chrome: chrome as SectionNav['chrome'] })}
          />
          <SelectRow
            label={t(M['sections.size'])}
            value={current.size}
            options={(['sm', 'md', 'lg'] as const).map((value) => [value, t(M[`sections.size_${value}`])])}
            onChange={(size) => patchNav({ size: size as SectionNav['size'] })}
          />
          <SelectRow
            label={t(M['sections.connector'])}
            value={current.connector}
            options={SECTION_NAV_CONNECTORS.map((value) => [value, t(M[`sections.connector_${value}`])])}
            onChange={(connector) => patchNav({ connector: connector as SectionNav['connector'] })}
          />
          <SelectRow
            label={t(M['sections.position'])}
            value={position}
            options={[
              ['top', t(M['sections.placement_top'])],
              ['bottom', t(M['sections.placement_bottom'])],
            ]}
            onChange={(placement) => patchNav({ placement: placement as 'top' | 'bottom', sticky: false })}
          />
          <SelectRow
            label={t(M['sections.current'])}
            value={current.currentMarker}
            options={SECTION_NAV_CURRENT.map((value) => [value, t(M[`sections.current_${value}`])])}
            onChange={(currentMarker) => patchNav({ currentMarker: currentMarker as SectionNav['currentMarker'] })}
          />
          <SelectRow
            label={t(M['sections.align'])}
            value={current.align}
            options={[
              ['start', t(M['sections.align_start'])],
              ['center', t(M['sections.align_center'])],
              ['end', t(M['sections.align_end'])],
            ]}
            onChange={(align) => patchNav({ align: align as SectionNav['align'] })}
          />
          <ToggleRow id="section-submit" label={t(M['sections.submit'])} checked={current.includeSubmit} onChange={(includeSubmit) => patchNav({ includeSubmit })} />
        </>
      ) : null}
    </div>
  );
}

function ToggleRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sidebar-foreground/80">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <NiceSelect size="sm" aria-label={label} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  );
}

function NumberRow({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        className="border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </div>
  );
}

function ColorRow({ label, value, fallback, onChange }: { label: string; value: string | undefined; fallback: string; onChange: (v: HexColor) => void }) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? (value as string) : fallback;
  const [text, setText] = useDraft(hex);
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value as HexColor)} className="size-9 cursor-pointer rounded-md border border-sidebar-border bg-transparent" />
        <Input className="border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground" value={text} onChange={(e) => { setText(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value as HexColor); }} />
      </div>
    </div>
  );
}
