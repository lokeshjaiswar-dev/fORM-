import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Paintbrush, X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { DEFAULT_COLORS } from '@form/renderer';
import type { FontId, HexColor, Theme, ThemeColorToken, ThemeTokens } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { cn } from '@/lib/utils';
import { setTheme } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { Input, Label } from '@/components/ui/input';
import { NiceSelect } from '@/components/ui/select';
import { SubmissionSettings } from '@/components/builder/ThemeSettings';
import { applyPreset, applyScheme, COLOR_SCHEMES, matchingPresetId, matchingSchemeId, THEME_PRESETS } from '@/components/builder/design/presets';

const M = defineMessages('builder', {
  'design.open': 'Form design',
  'design.close': 'Close',
  'design.title': 'Form design',
  'design.colors': 'Colors',
  'design.styles': 'Styles',
  'design.themes': 'Themes',
  'design.layout': 'Layout',
  'design.submit': 'Submit',
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
  'design.classic': 'Classic',
  'design.classic_hint': 'All questions on one page',
  'design.cards': 'Cards',
  'design.cards_hint': 'A rounder, roomier sheet',
  'design.search': 'Search themes',
  'design.current': 'Current',
});

const TABS = ['colors', 'styles', 'themes', 'layout', 'submit'] as const;
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

export function FormDesignPanel({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('colors');
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const theme = useDoc((d) => d.theme);
  const tokens = theme.tokens;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (panelRef.current?.contains(node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        {!open ? (
          <button
            type="button"
            aria-label={t(M['design.open'])}
            onClick={() => setOpen(true)}
            className="absolute right-5 top-5 z-20 flex size-12 items-center justify-center rounded-full bg-[#2563eb] text-white shadow-lg shadow-blue-900/20 hover:bg-[#1d4ed8]"
          >
            <Paintbrush className="size-5" />
          </button>
        ) : null}
      </div>
      <aside className={cn('min-h-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-out', open ? 'w-[min(100%,380px)]' : 'w-0')}>
        {open ? (
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t(M['design.title'])}
            className="flex h-full w-[380px] max-w-[100vw] flex-col bg-[#2b2a33] text-zinc-100 shadow-2xl"
          >
            <div className="flex items-center justify-between px-4 pt-4">
              <h2 className="text-[16px] font-semibold">{t(M['design.title'])}</h2>
              <button type="button" aria-label={t(M['design.close'])} className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex gap-1 px-3">
              {TABS.map((id) => {
                const label =
                  id === 'colors' ? t(M['design.colors'])
                  : id === 'styles' ? t(M['design.styles'])
                  : id === 'themes' ? t(M['design.themes'])
                  : id === 'layout' ? t(M['design.layout'])
                  : t(M['design.submit']);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      'flex-1 border-b-2 px-0.5 py-2 text-[10px] font-medium uppercase tracking-wide',
                      tab === id ? 'border-orange-400 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {tab === 'colors' ? (
                <div className="space-y-5">
                  <section>
                    <p className="mb-3 text-[12px] font-medium uppercase tracking-wide text-zinc-400">{t(M['design.schemes'])}</p>
                    <div className="grid grid-cols-6 gap-2">
                      {schemes.map((scheme) => (
                        <button
                          key={scheme.id}
                          type="button"
                          aria-label={scheme.name}
                          aria-pressed={schemeId === scheme.id}
                          onClick={() => patch(applyScheme(theme, scheme))}
                          className={cn('flex aspect-square items-center justify-center rounded-lg border-2 text-[13px] font-semibold', schemeId === scheme.id ? 'border-orange-400' : 'border-white/10')}
                          style={{ background: scheme.surface, color: scheme.accent }}
                        >
                          A
                        </button>
                      ))}
                    </div>
                  </section>
                  <ColorField label={t(M['design.page'])} value={tokens.colors.page} fallback={DEFAULT_COLORS.page} onChange={(v) => setColor('page', v)} />
                  <ColorField label={t(M['design.form'])} value={tokens.colors.surface} fallback={DEFAULT_COLORS.surface} onChange={(v) => setColor('surface', v)} />
                  <ColorField label={t(M['design.text'])} value={tokens.colors.text} fallback={DEFAULT_COLORS.text} onChange={(v) => setColor('text', v)} />
                  <ColorField label={t(M['design.accent'])} value={tokens.colors.accent} fallback={DEFAULT_COLORS.accent} onChange={(v) => setColor('accent', v)} />
                  <ColorField label={t(M['design.input'])} value={tokens.colors.inputBg} fallback={DEFAULT_COLORS.inputBg} onChange={(v) => setColor('inputBg', v)} />
                </div>
              ) : null}

              {tab === 'styles' ? (
                <div className="space-y-4">
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
                      onChange={(body) => patchTokens({ typography: { ...tokens.typography, body: body as FontId } })}
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
                  <button
                    type="button"
                    onClick={() => patchTokens({ progress: tokens.progress === 'none' ? 'bar' : 'none' })}
                    className="w-full rounded-md bg-white/10 px-3 py-2 text-left text-[13px] hover:bg-white/15"
                  >
                    {t(M['design.progress'])}: {tokens.progress === 'none' ? 'Off' : 'On'}
                  </button>
                </div>
              ) : null}

              {tab === 'themes' ? (
                <div className="space-y-3">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t(M['design.search'])}
                    aria-label={t(M['design.search'])}
                    className="h-9 w-full rounded-md border border-white/10 bg-white/5 px-3 text-[13px] text-white outline-none placeholder:text-zinc-500"
                  />
                  <div className="grid grid-cols-2 gap-3">
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
                          className={cn('overflow-hidden rounded-xl border-2 text-left', selected ? 'border-orange-400' : 'border-white/10')}
                        >
                          <div className="relative h-24 p-3" style={{ background: page }}>
                            {selected ? <span className="absolute left-2 top-2 rounded bg-[#2563eb] px-1.5 py-0.5 text-[10px] font-medium text-white">{t(M['design.current'])}</span> : null}
                            <div className="ml-auto h-full w-[58%] rounded-md p-2 shadow-sm" style={{ background: surface }}>
                              <div className="mb-1 h-1.5 w-2/3 rounded" style={{ background: hexOf(preset.tokens.colors.text, '#111') }} />
                              <div className="mb-1 h-4 rounded border" style={{ borderColor: '#d4d4d8' }} />
                              <div className="h-3 w-10 rounded" style={{ background: accent }} />
                            </div>
                          </div>
                          <p className="bg-[#34333d] px-2 py-2 text-[12px] font-medium">{preset.name}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {tab === 'layout' ? (
                <div className="grid gap-3">
                  {([
                    ['classic', M['design.classic'], M['design.classic_hint'], '#f59e0b'],
                    ['cards', M['design.cards'], M['design.cards_hint'], '#60a5fa'],
                  ] as const).map(([id, title, hint, tint]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={theme.layout === id}
                      onClick={() => patch({ ...theme, layout: id })}
                      className={cn('overflow-hidden rounded-xl border-2 text-left', theme.layout === id ? 'border-orange-400' : 'border-white/10')}
                    >
                      <div className="flex h-28 items-center justify-center p-4" style={{ background: tint }}>
                        <div className={cn('bg-white shadow-md', id === 'cards' ? 'h-20 w-24 rounded-2xl' : 'h-[88px] w-28 rounded-md')} />
                      </div>
                      <div className="bg-[#34333d] px-3 py-2">
                        <p className="text-[13px] font-semibold">{t(title)}</p>
                        <p className="text-[12px] text-zinc-400">{t(hint)}</p>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}

              {tab === 'submit' ? <SubmissionSettings dark /> : null}
            </div>
          </div>
        ) : null}
      </aside>
    </div>
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
      <Label className="text-zinc-300">{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value)} className="size-9 cursor-pointer rounded-md border border-white/10 bg-transparent" />
        <Input className="border-white/10 bg-white/5 text-white" value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} />
      </div>
    </div>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-zinc-300">{label}</Label>
      <NiceSelect size="sm" value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-zinc-300">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        className="border-white/10 bg-white/5 text-white"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </div>
  );
}
