import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Paintbrush, X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { DEFAULT_COLORS } from '@form/renderer/author';
import type { FontId, HexColor, Theme, ThemeColorToken, ThemeTokens } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { cn } from '@/lib/utils';
import { switchBuilderView } from '@/lib/viewTransition';
import { TabGlide } from '@/components/TabGlide';
import { setTheme } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Button, Input, SearchInput } from '@dmacq/ui';
import { Tooltip } from '@/components/Tooltip';
import { NiceSelect } from '@/components/NiceSelect';
import { SubmissionSettings } from '@/components/builder/ThemeSettings';
import { LookupSettings } from '@/components/builder/LookupSettings';
import { DmsLookupSettings } from '@/components/builder/DmsLookupSettings';
import { useProfile } from '@/embed/useProfile';
import { FormLogicChecks } from '@/components/builder/FormLogicPanel';
import { useUiStore } from '@/state/uiStore';
import { ReviewSettings } from '@/components/builder/review/ReviewSettings';
import { SectionBreakSettings } from '@/components/builder/SectionBreakSettings';
import { ImagesSection } from '@/components/builder/design/ImagesSection';
import { useShownDesignTabs } from '@/components/builder/design/shownTabs';
import { applyImageTemplate, applyPreset, applyScheme, COLOR_SCHEMES, IMAGE_TEMPLATES, matchingPresetId, matchingSchemeId, THEME_PRESETS } from '@/components/builder/design/presets';
import { themeImageUrl } from '@form/renderer/author';
import '@/components/builder/inspector/inspectorFields.css';
import { SettingsPanelContext } from '@/components/builder/inspector/settingsPanelScope';
import { Field, InspectorSection, Segment, SegmentedGroup, ToggleRow } from '@/components/builder/inspector/parts';

const M = defineMessages('builder', {
  'design.open': 'Form settings',
  'design.close': 'Close',
  'design.back': 'Back to form builder',
  'design.title': 'Form settings',
  'design.colors': 'Colors',
  'design.styles': 'Layout',
  'design.themes': 'Themes',
  'design.submit': 'Submit',
  'design.lookup': 'API autofill',
  'design.lookup_dms': 'Fill from master',
  'design.logic': 'Rules',
  'design.sections': 'Sections',
  'design.review': 'Review',
  'design.schemes': 'Palettes',
  'design.custom_colors': 'Custom colors',
  'design.images': 'Background and cover',
  'design.layout_form': 'Form',
  'design.layout_text': 'Text',
  'design.layout_fields': 'Fields',
  'design.progress_hint': 'A thin bar at the top that fills as respondents move through the form.',
  'design.themes_heading': 'Themes',
  'design.no_themes': 'No themes match “{query}”.',
  'design.page': 'Page background',
  'design.form': 'Form surface',
  'design.text': 'Text',
  'design.accent': 'Buttons',
  'design.input': 'Input background',
  'design.width': 'Form width',
  'design.align': 'Label position',
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

/* By how often authors need them: a look first, then its colours and layout, what happens on submit, then the advanced
   tools (rules, section navigation, review, API autofill). The panel opens on Themes, the fastest way to a finished look. */
const ALL_TABS = ['themes', 'colors', 'styles', 'submit', 'logic', 'sections', 'review', 'lookup'] as const;
type Tab = (typeof ALL_TABS)[number];

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
  const [tab, setTab] = useState<Tab>('themes');
  /* A tab opens at its top, not at the scroll position the last tab was left at. */
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (regionRef.current) regionRef.current.scrollTop = 0;
  }, [tab]);
  const [query, setQuery] = useState('');
  const profile = useProfile();
  /* The Masters builder (profile dms-v1) has no Rules and no Sections (design/shownTabs.ts). */
  const shownTabs = useShownDesignTabs();
  const TABS = ALL_TABS.filter((id) => (shownTabs as Partial<Record<Tab, boolean>>)[id] !== false);
  const theme = useDoc((d) => d.theme);
  const tokens = theme.tokens;
  /* Opening and closing go through the builder's view switch, which slides the panel in and out (index.css). */
  const toggle = (next: boolean) => switchBuilderView(() => setOpen(next));
  const showPanel = open;

  const patch = (next: Theme) => setTheme(next);
  const patchTokens = (partial: Partial<ThemeTokens>) => patch({ ...theme, tokens: { ...tokens, ...partial } });
  const setColor = (token: ThemeColorToken, value: string) => {
    if (!HEX.test(value)) return;
    const colors = { ...tokens.colors, [token]: value as HexColor };
    const background = token === 'page' ? ({ kind: 'color' as const, color: value as HexColor }) : tokens.background;
    patchTokens({ colors, ...(token === 'page' ? { background } : {}) });
  };

  const schemes = COLOR_SCHEMES;
  const needle = query.trim().toLowerCase();
  const themes = THEME_PRESETS.filter((p) => p.name.toLowerCase().includes(needle));
  const images = IMAGE_TEMPLATES.filter((template) => template.name.toLowerCase().includes(needle));
  const schemeId = matchingSchemeId(theme);
  const presetId = matchingPresetId(theme);

  const tabLabel = (id: Tab) =>
    id === 'colors' ? t(M['design.colors'])
    : id === 'styles' ? t(M['design.styles'])
    : id === 'themes' ? t(M['design.themes'])
    : id === 'logic' ? t(M['design.logic'])
    : id === 'sections' ? t(M['design.sections'])
    : id === 'review' ? t(M['design.review'])
    : id === 'lookup' ? t(M[profile === 'dms-v1' ? 'design.lookup_dms' : 'design.lookup'])
    : t(M['design.submit']);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className={cn('vt-builder-stage relative flex min-h-0 min-w-0 flex-col', showPanel ? 'w-1/2 shrink-0 overflow-hidden' : 'flex-1')}>
        {children}
        {!open && showTrigger ? (
          <Tooltip content={t(M['design.open'])} side="right" className="absolute right-5 top-5 z-20">
            <Button
              type="button"
              size="icon-lg"
              aria-label={t(M['design.open'])}
              onClick={() => toggle(true)}
              className="rounded-full shadow-lg"
            >
              <Paintbrush className="size-5" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {showPanel ? (
    <SettingsPanelContext.Provider value>
    <div data-settings-panel className="vt-builder-side relative flex min-h-0 min-w-0 w-1/2 shrink-0 flex-col border-l border-border bg-card text-foreground">
      {/* The same frame as the block settings panel: a 48px title row, then the grey tab track 16px in from the edges. */}
      <nav aria-label={t(M['design.title'])} className="flex w-full shrink-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
          <h2 className="min-w-0 truncate text-[14px] font-semibold leading-5 text-foreground">{t(M['design.title'])}</h2>
          <Tooltip content={t(M['design.close'])}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['design.close'])} onClick={() => toggle(false)}>
              <X className="size-4" />
            </Button>
          </Tooltip>
        </div>
        <div className="px-4 pt-1">
          <div role="tablist" aria-orientation="horizontal" className="relative flex h-8 w-full gap-0.5 overflow-x-auto rounded-[8px] bg-(--bluedark-100) p-[3px]">
            <TabGlide active={tab} className="rounded-[6px] bg-card shadow-[0_2px_8px_rgba(25,40,57,0.09)]" />
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  'relative h-[26px] flex-1 whitespace-nowrap rounded-[6px] px-3 text-[12px] font-semibold leading-4 outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-ring',
                  tab === id ? 'text-primary-text' : 'text-(--bluedark-800) hover:text-foreground',
                )}
              >
                {tabLabel(id)}
              </button>
            ))}
          </div>
        </div>
      </nav>
      <div ref={regionRef} role="region" aria-label={t(M['design.title'])} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div key={tab} className="design-tab-in w-full pb-6">
              {tab === 'themes' ? (
                <>
                  {/* Search stays at the top while the gallery scrolls under it. */}
                  <div className="sticky top-0 z-10 border-b border-border-default bg-card px-4 py-3">
                    <SearchInput value={query} onValueChange={setQuery} placeholder={t(M['design.search'])} aria-label={t(M['design.search'])} />
                  </div>
                  {themes.length || images.length ? null : (
                    <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{t(M['design.no_themes'], { query: query.trim() })}</p>
                  )}
                  {themes.length ? (
                    <SettingCard title={t(M['design.themes_heading'])}>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                        {themes.map((preset) => (
                          <ThemeTile
                            key={preset.id}
                            name={preset.name}
                            selected={presetId === preset.id}
                            onPick={() => patch(applyPreset(theme, preset))}
                            preview={
                              <PresetPreview
                                page={hexOf(preset.tokens.colors.page, DEFAULT_COLORS.page)}
                                surface={hexOf(preset.tokens.colors.surface, DEFAULT_COLORS.surface)}
                                text={hexOf(preset.tokens.colors.text, '#111')}
                                accent={hexOf(preset.tokens.colors.accent, DEFAULT_COLORS.accent)}
                              />
                            }
                          />
                        ))}
                      </div>
                    </SettingCard>
                  ) : null}
                  {images.length ? (
                    <SettingCard title={t(M['design.image_themes'])}>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                        {images.map((template) => {
                          const preview = themeImageUrl(template.scene);
                          return (
                            <ThemeTile
                              key={template.id}
                              name={template.name}
                              selected={presetId === template.id}
                              onPick={() => patch(applyImageTemplate(theme, template))}
                              preview={
                                <>
                                  {preview ? <img alt="" src={preview} className="absolute inset-0 h-full w-full object-cover" /> : null}
                                  <div className="absolute inset-x-3 bottom-3 h-8 rounded-md bg-white/90 shadow-sm" />
                                </>
                              }
                            />
                          );
                        })}
                      </div>
                    </SettingCard>
                  ) : null}
                </>
              ) : null}

              {tab === 'colors' ? (
                <>
                  <SettingCard title={t(M['design.schemes'])}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                      {schemes.map((scheme) => (
                        <PaletteSwatch key={scheme.id} scheme={scheme} selected={schemeId === scheme.id} onPick={() => patch(applyScheme(theme, scheme))} />
                      ))}
                    </div>
                  </SettingCard>
                  <SettingCard title={t(M['design.custom_colors'])}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ColorField label={t(M['design.accent'])} value={tokens.colors.accent} fallback={DEFAULT_COLORS.accent} onChange={(v) => setColor('accent', v)} />
                      <ColorField label={t(M['design.text'])} value={tokens.colors.text} fallback={DEFAULT_COLORS.text} onChange={(v) => setColor('text', v)} />
                      <ColorField label={t(M['design.page'])} value={tokens.colors.page} fallback={DEFAULT_COLORS.page} onChange={(v) => setColor('page', v)} />
                      <ColorField label={t(M['design.form'])} value={tokens.colors.surface} fallback={DEFAULT_COLORS.surface} onChange={(v) => setColor('surface', v)} />
                      <ColorField label={t(M['design.input'])} value={tokens.colors.inputBg} fallback={DEFAULT_COLORS.inputBg} onChange={(v) => setColor('inputBg', v)} />
                    </div>
                  </SettingCard>
                  <SettingCard title={t(M['design.images'])}>
                    <ImagesSection theme={theme} onChange={patch} />
                  </SettingCard>
                </>
              ) : null}

              {tab === 'styles' ? (
                <>
                  <SettingCard title={t(M['design.layout_form'])}>
                    <Choice label={t(M['design.width'])} value={tokens.formWidth} options={WIDTHS} onChange={(formWidth) => patchTokens({ formWidth: formWidth as ThemeTokens['formWidth'] })} />
                    <Choice label={t(M['design.align'])} value={tokens.labelAlign} options={ALIGNS} onChange={(labelAlign) => patchTokens({ labelAlign: labelAlign as ThemeTokens['labelAlign'] })} />
                    <Choice label={t(M['design.spacing'])} value={tokens.density} options={DENSITY} onChange={(density) => patchTokens({ density: density as ThemeTokens['density'] })} />
                  </SettingCard>
                  <SettingCard title={t(M['design.layout_text'])}>
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
                  </SettingCard>
                  <SettingCard title={t(M['design.layout_fields'])}>
                    <Choice label={t(M['design.inputs'])} value={tokens.inputStyle} options={INPUTS} onChange={(inputStyle) => patchTokens({ inputStyle: inputStyle as ThemeTokens['inputStyle'] })} />
                    <Choice label={t(M['design.radius'])} value={typeof tokens.radius === 'string' ? tokens.radius : 'md'} options={RADII} onChange={(radius) => patchTokens({ radius: radius as ThemeTokens['radius'] })} />
                    <ToggleRow label={t(M['design.progress'])} hint={t(M['design.progress_hint'])} checked={tokens.progress !== 'none'} onChange={(on) => patchTokens({ progress: on ? 'bar' : 'none' })} />
                  </SettingCard>
                </>
              ) : null}

              {tab === 'logic' ? <SettingCard><FormLogicChecks /></SettingCard> : null}

              {tab === 'sections' ? <SectionBreakSettings /> : null}

              {tab === 'review' ? <SettingCard><ReviewSettings /></SettingCard> : null}
              {tab === 'lookup' ? <SettingCard>{profile === 'dms-v1' ? <DmsLookupSettings /> : <LookupSettings />}</SettingCard> : null}
              {tab === 'submit' ? <SubmissionSettings /> : null}
        </div>
      </div>
    </div>
    </SettingsPanelContext.Provider>
      ) : null}
    </div>
  );
}

/** A 2 to 5 option setting as one row of segments: every choice is visible and one click away. */
function Choice({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <SegmentedGroup type="single" aria-label={label} value={value} onValueChange={(v) => v && onChange(v)}>
        {options.map(([v, l]) => (
          <Segment key={v} value={v}>{l}</Segment>
        ))}
      </SegmentedGroup>
    </Field>
  );
}

/** A theme in the gallery: its preview, its name, and a check and blue frame when it is the one in use. */
function ThemeTile({ name, selected, onPick, preview }: { name: string; selected: boolean; onPick: () => void; preview: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={name}
      onClick={onPick}
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-[8px] border text-left outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border-default hover:border-(--bluedark-500) hover:shadow-[0_2px_8px_rgba(25,40,57,0.09)]',
      )}
    >
      <div className="relative h-20 w-full overflow-hidden">{preview}</div>
      <span className="flex items-center justify-between gap-2 border-t border-border-default bg-card px-2.5 py-2 text-[12px] font-medium leading-4 text-foreground">
        <span className="truncate">{name}</span>
        {selected ? <Check aria-hidden className="size-3.5 shrink-0 text-primary-text" /> : null}
      </span>
    </button>
  );
}

/** A miniature form in the preset's colours: page, card, a title line, a field and a button. */
function PresetPreview({ page, surface, text, accent }: { page: string; surface: string; text: string; accent: string }) {
  return (
    <div className="absolute inset-0 p-2.5" style={{ background: page }}>
      <div className="ml-auto h-full w-[62%] rounded-[6px] p-2 shadow-sm" style={{ background: surface }}>
        <div className="mb-1.5 h-1.5 w-2/3 rounded" style={{ background: text }} />
        <div className="mb-1.5 h-3.5 rounded border" style={{ borderColor: 'rgb(108 132 157 / 0.32)' }} />
        <div className="h-3 w-9 rounded" style={{ background: accent }} />
      </div>
    </div>
  );
}

/** A colour palette shown as its colours: the page, the form card on it, the text and the button colour. */
function PaletteSwatch({ scheme, selected, onPick }: { scheme: (typeof COLOR_SCHEMES)[number]; selected: boolean; onPick: () => void }) {
  const page = scheme.gradient ? `linear-gradient(${scheme.gradient.angle}deg, ${scheme.gradient.from}, ${scheme.gradient.to})` : scheme.page;
  return (
    <button
      type="button"
      aria-label={scheme.name}
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        'flex flex-col overflow-hidden rounded-[8px] border text-left outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border-default hover:border-(--bluedark-500)',
      )}
    >
      <span className="block h-12 p-2" style={{ background: page }}>
        <span className="flex h-full flex-col justify-between rounded-[4px] p-1.5 shadow-sm" style={{ background: scheme.surface }}>
          <span className="block h-1 w-3/4 rounded-full" style={{ background: scheme.text }} />
          <span className="block h-2 w-6 rounded-[2px]" style={{ background: scheme.accent }} />
        </span>
      </span>
      <span className="flex items-center justify-between gap-1 border-t border-border-default bg-card px-2 py-1.5 text-[11px] font-medium leading-4 text-foreground">
        <span className="truncate">{scheme.name}</span>
        {selected ? <Check aria-hidden className="size-3 shrink-0 text-primary-text" /> : null}
      </span>
    </button>
  );
}

/** One group of settings: the panel section (full-width band, divider under it, Toolbox-style heading). */
function SettingCard({ title, children }: { title?: string; children: ReactNode }) {
  return <InspectorSection {...(title ? { title } : {})}>{children}</InspectorSection>;
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function ColorField({ label, value, fallback, onChange }: { label: string; value: unknown; fallback: string; onChange: (v: string) => void }) {
  const hex = hexOf(value, fallback);
  const [text, setText] = useDraft(hex);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value)} className="size-8 shrink-0 cursor-pointer rounded-[8px] border border-border-default bg-card p-0.5" />
        <Input value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} />
      </div>
    </Field>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <NiceSelect size="sm" aria-label={label} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </Field>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useDraft(String(value));
  return (
    <Field label={label}>
      <Input
        inputMode="numeric"
        value={draft}
        aria-label={label}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </Field>
  );
}
