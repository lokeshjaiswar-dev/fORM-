import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Paintbrush } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { DEFAULT_COLORS } from '@form/renderer';
import type { FontId, HexColor, Theme, ThemeColorToken, ThemeTokens } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { cn } from '@/lib/utils';
import { setTheme } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Button, Input, Label, SearchInput } from '@dmacq/ui';
import { Tooltip } from '@/components/Tooltip';
import { NiceSelect } from '@/components/NiceSelect';
import { SubmissionSettings } from '@/components/builder/ThemeSettings';
import { LookupSettings } from '@/components/builder/LookupSettings';
import { FormLogicChecks } from '@/components/builder/FormLogicPanel';
import { useUiStore } from '@/state/uiStore';
import { SectionBreakSettings } from '@/components/builder/SectionBreakSettings';
import { ImagesSection } from '@/components/builder/design/ImagesSection';
import { applyImageTemplate, applyPreset, applyScheme, COLOR_SCHEMES, IMAGE_TEMPLATES, matchingPresetId, matchingSchemeId, THEME_PRESETS } from '@/components/builder/design/presets';
import { themeImageUrl } from '@form/renderer';

const M = defineMessages('builder', {
  'design.open': 'Form settings',
  'design.close': 'Close',
  'design.back': 'Back to form builder',
  'design.title': 'Form settings',
  'design.colors': 'Colors',
  'design.styles': 'Styles',
  'design.themes': 'Themes',
  'design.submit': 'Submit',
  'design.lookup': 'API autofill',
  'design.logic': 'Rules',
  'design.sections': 'Sections',
  'design.schemes': 'Color palette',
  'design.page': 'Page background',
  'design.form': 'Form surface',
  'design.text': 'Text',
  'design.accent': 'Buttons',
  'design.input': 'Input background',
  'design.width': 'Form width',
  'design.align': 'Label alignment',
  'design.spacing': 'Question spacing',
  'design.font': 'Font',
  'design.size': 'Font size',
  'design.radius': 'Corners',
  'design.inputs': 'Input style',
  'design.progress': 'Progress bar',
  'design.search': 'Search themes',
  'design.current': 'Current',
  'design.image_themes': 'Image templates',
});

const TABS = ['colors', 'styles', 'themes', 'logic', 'sections', 'lookup', 'submit'] as const;
type Tab = (typeof TABS)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS = [['inter', 'Inter'], ['georgia', 'Georgia'], ['mono', 'Mono']] as const;
const WIDTHS = [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']] as const;
const ALIGNS = [['top', 'Top'], ['left', 'Left'], ['right', 'Right']] as const;
const DENSITY = [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']] as const;
const RADII = [['none', 'Square'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['full', 'Pill']] as const;
const INPUTS = [['outlined', 'Outlined'], ['filled', 'Filled'], ['underlined', 'Underlined']] as const;

function hexOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value : fallback;
}

export function FormDesignPanel({ children, showTrigger = true }: { children?: ReactNode; showTrigger?: boolean }) {
  const open = useUiStore((s) => s.designOpen);
  const setOpen = useUiStore((s) => s.setDesignOpen);
  const [tab, setTab] = useState<Tab>('colors');
  const [query, setQuery] = useState('');
  const theme = useDoc((d) => d.theme);
  const tokens = theme.tokens;
  const [switchMark, setSwitchMark] = useState(0);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    setSwitchMark((n) => n + 1);
  }, [open]);

  const patch = (next: Theme) => setTheme(next);
  const patchTokens = (partial: Partial<ThemeTokens>) => patch({ ...theme, tokens: { ...tokens, ...partial } });
  const setColor = (token: ThemeColorToken, value: string) => {
    if (!HEX.test(value)) return;
    const colors = { ...tokens.colors, [token]: value as HexColor };
    const background = token === 'page' ? ({ kind: 'color' as const, color: value as HexColor }) : tokens.background;
    patchTokens({ colors, ...(token === 'page' ? { background } : {}) });
  };

  const schemes = COLOR_SCHEMES;
  const themes = THEME_PRESETS.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const schemeId = matchingSchemeId(theme);
  const presetId = matchingPresetId(theme);

  const tabLabel = (id: Tab) =>
    id === 'colors' ? t(M['design.colors'])
    : id === 'styles' ? t(M['design.styles'])
    : id === 'themes' ? t(M['design.themes'])
    : id === 'logic' ? t(M['design.logic'])
    : id === 'sections' ? t(M['design.sections'])
    : id === 'lookup' ? t(M['design.lookup'])
    : t(M['design.submit']);

  if (!open) {
    return (
      <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col', switchMark > 0 && 'design-view-back')}>
        {children}
        {showTrigger ? (
          <Tooltip content={t(M['design.open'])} side="right" className="absolute right-5 top-5 z-20">
            <Button
              type="button"
              size="icon-lg"
              aria-label={t(M['design.open'])}
              onClick={() => setOpen(true)}
              className="rounded-full shadow-lg"
            >
              <Paintbrush className="size-5" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('ov-theme-dark relative flex min-h-0 min-w-0 flex-1 bg-sidebar text-sidebar-foreground', switchMark > 0 && 'design-view-in')}>
      <svg aria-hidden viewBox="0 0 100 2" preserveAspectRatio="none" className="design-switch-rule pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 w-full text-sidebar-primary">
        <path d="M0 1h100" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <nav aria-label={t(M['design.title'])} className="flex w-[252px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="px-3 pt-4">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-sidebar-foreground" onClick={() => setOpen(false)}>
            <ArrowLeft className="size-4" />
            {t(M['design.back'])}
          </Button>
          <h2 className="px-2 pb-2 pt-4 text-[13px] font-semibold uppercase tracking-[0.14em] text-sidebar-muted">{t(M['design.title'])}</h2>
        </div>
        <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5 px-2">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'rounded-md border-l-2 px-3 py-2 text-left text-[14px]',
                tab === id
                  ? 'border-sidebar-primary bg-sidebar-accent font-medium text-sidebar-foreground'
                  : 'border-transparent text-sidebar-muted hover:bg-sidebar-accent/40',
              )}
            >
              {tabLabel(id)}
            </button>
          ))}
        </div>
      </nav>
      <div role="region" aria-label={t(M['design.title'])} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-sidebar">
        <div key={tab} className="design-tab-in w-full px-6 py-6">
          <h2 className="mb-5 text-[22px] font-semibold text-sidebar-foreground">{tabLabel(tab)}</h2>
              {tab === 'colors' ? (
                <div className="space-y-4">
                  <SettingCard title={t(M['design.schemes'])}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,4.5rem))] gap-2">
                      {schemes.map((scheme) => (
                        <button
                          key={scheme.id}
                          type="button"
                          aria-label={scheme.name}
                          aria-pressed={schemeId === scheme.id}
                          onClick={() => patch(applyScheme(theme, scheme))}
                          className={cn(
                            'flex aspect-square items-center justify-center rounded-lg border-2 text-[13px] font-semibold',
                            schemeId === scheme.id ? 'border-sidebar-primary' : 'border-sidebar-border',
                          )}
                          style={{ background: scheme.surface, color: scheme.accent }}
                        >
                          A
                        </button>
                      ))}
                    </div>
                  </SettingCard>
                  <SettingCard title={t(M['design.colors'])}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ColorField label={t(M['design.page'])} value={tokens.colors.page} fallback={DEFAULT_COLORS.page} onChange={(v) => setColor('page', v)} />
                    <ColorField label={t(M['design.form'])} value={tokens.colors.surface} fallback={DEFAULT_COLORS.surface} onChange={(v) => setColor('surface', v)} />
                    <ColorField label={t(M['design.text'])} value={tokens.colors.text} fallback={DEFAULT_COLORS.text} onChange={(v) => setColor('text', v)} />
                    <ColorField label={t(M['design.accent'])} value={tokens.colors.accent} fallback={DEFAULT_COLORS.accent} onChange={(v) => setColor('accent', v)} />
                    <ColorField label={t(M['design.input'])} value={tokens.colors.inputBg} fallback={DEFAULT_COLORS.inputBg} onChange={(v) => setColor('inputBg', v)} />
                  </div>
                  </SettingCard>
                  <SettingCard>
                    <ImagesSection theme={theme} onChange={patch} />
                  </SettingCard>
                </div>
              ) : null}

              {tab === 'styles' ? (
                <SettingCard>
                  <Pair>
                    <SelectField label={t(M['design.width'])} value={tokens.formWidth} options={WIDTHS} onChange={(formWidth) => patchTokens({ formWidth: formWidth as ThemeTokens['formWidth'] })} />
                    <SelectField label={t(M['design.align'])} value={tokens.labelAlign} options={ALIGNS} onChange={(labelAlign) => patchTokens({ labelAlign: labelAlign as ThemeTokens['labelAlign'] })} />
                  </Pair>
                  <Pair>
                    <SelectField label={t(M['design.spacing'])} value={tokens.density} options={DENSITY} onChange={(density) => patchTokens({ density: density as ThemeTokens['density'] })} />
                    <SelectField label={t(M['design.radius'])} value={typeof tokens.radius === 'string' ? tokens.radius : 'md'} options={RADII} onChange={(radius) => patchTokens({ radius: radius as ThemeTokens['radius'] })} />
                  </Pair>
                  <Pair>
                    <SelectField
                      label={t(M['design.font'])}
                      value={typeof tokens.typography.body === 'string' ? tokens.typography.body : 'inter'}
                      options={FONTS}
                      onChange={(body) => patchTokens({ typography: { ...tokens.typography, body: body as FontId, heading: body as FontId } })}
                    />
                    <NumberField
                      label={t(M['design.size'])}
                      value={tokens.typography.baseSizePx}
                      min={12}
                      max={24}
                      onChange={(baseSizePx) => patchTokens({ typography: { ...tokens.typography, baseSizePx } })}
                    />
                  </Pair>
                  <SelectField label={t(M['design.inputs'])} value={tokens.inputStyle} options={INPUTS} onChange={(inputStyle) => patchTokens({ inputStyle: inputStyle as ThemeTokens['inputStyle'] })} />
                  <Button
                    type="button"
                    variant="secondary"
                    className="justify-start"
                    onClick={() => patchTokens({ progress: tokens.progress === 'none' ? 'bar' : 'none' })}
                  >
                    {t(M['design.progress'])}: {tokens.progress === 'none' ? 'Off' : 'On'}
                  </Button>
                </SettingCard>
              ) : null}

              {tab === 'themes' ? (
                <div className="space-y-4">
                <SettingCard>
                  <div className="max-w-sm">
                    <SearchInput
                      value={query}
                      onValueChange={setQuery}
                      placeholder={t(M['design.search'])}
                      aria-label={t(M['design.search'])}
                    />
                  </div>
                  <p className="text-[12px] font-medium uppercase tracking-wide text-sidebar-muted">{t(M['design.image_themes'])}</p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                    {IMAGE_TEMPLATES.filter((template) => template.name.toLowerCase().includes(query.trim().toLowerCase())).map((template) => {
                      const selected = presetId === template.id;
                      const preview = themeImageUrl(template.scene);
                      return (
                        <button
                          key={template.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => patch(applyImageTemplate(theme, template))}
                          className={cn('flex w-full flex-col overflow-hidden rounded-xl border-2 text-left', selected ? 'border-sidebar-primary' : 'border-sidebar-border')}
                        >
                          <div className="relative h-24 w-full">
                            {preview ? <img alt="" src={preview} className="absolute inset-0 h-full w-full object-cover" /> : null}
                            <div className="absolute inset-x-3 bottom-3 h-10 rounded-md bg-white/90 shadow-sm" />
                          </div>
                          <p className="bg-sidebar-accent/50 px-3 py-2 text-[12px] font-medium leading-5">{template.name}</p>
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                    {themes.map((preset) => {
                      const page = hexOf(preset.tokens.colors.page, DEFAULT_COLORS.page);
                      const surface = hexOf(preset.tokens.colors.surface, DEFAULT_COLORS.surface);
                      const accent = hexOf(preset.tokens.colors.accent, DEFAULT_COLORS.accent);
                      const selected = presetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => patch(applyPreset(theme, preset))}
                          className={cn(
                            'flex w-full flex-col overflow-hidden rounded-xl border-2 text-left',
                            selected ? 'border-sidebar-primary' : 'border-sidebar-border',
                          )}
                        >
                          <div className="relative h-24 w-full p-3" style={{ background: page }}>
                            {selected ? <span className="absolute left-2 top-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{t(M['design.current'])}</span> : null}
                            <div className="ml-auto h-full w-[58%] rounded-md p-2 shadow-sm" style={{ background: surface }}>
                              <div className="mb-1 h-1.5 w-2/3 rounded" style={{ background: hexOf(preset.tokens.colors.text, '#111') }} />
                              <div className="mb-1 h-4 rounded border" style={{ borderColor: '#d4d4d8' }} />
                              <div className="h-3 w-10 rounded" style={{ background: accent }} />
                            </div>
                          </div>
                          <p className="bg-sidebar-accent/50 px-3 py-2 text-[12px] font-medium leading-5">{preset.name}</p>
                        </button>
                      );
                    })}
                  </div>
                </SettingCard>
                </div>
              ) : null}

              {tab === 'logic' ? <SettingCard><FormLogicChecks /></SettingCard> : null}

              {tab === 'sections' ? <SettingCard><SectionBreakSettings /></SettingCard> : null}

              {tab === 'lookup' ? <SettingCard><LookupSettings /></SettingCard> : null}
              {tab === 'submit' ? <SettingCard><SubmissionSettings dark /></SettingCard> : null}
        </div>
      </div>
    </div>
  );
}

function SettingCard({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-sidebar-border bg-sidebar-accent/25 p-5">
      {title ? <p className="mb-4 text-[12px] font-medium uppercase tracking-wide text-sidebar-muted">{title}</p> : null}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function ColorField({ label, value, fallback, onChange }: { label: string; value: unknown; fallback: string; onChange: (v: string) => void }) {
  const hex = hexOf(value, fallback);
  const [text, setText] = useDraft(hex);
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value)} className="size-9 cursor-pointer rounded-md border border-sidebar-border bg-transparent" />
        <Input className="border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground" value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} />
      </div>
    </div>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <NiceSelect size="sm" aria-label={label} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useDraft(String(value));
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{label}</Label>
      <Input
        inputMode="numeric"
        value={draft}
        className="border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground"
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </div>
  );
}
