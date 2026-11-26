import type { FontId, HexColor, Theme, ThemeTokens } from '@form/schema';

const hex = (value: string) => value as HexColor;
const font = (value: string) => value as FontId;

export interface ColorScheme {
  id: string;
  name: string;
  accent: HexColor;
  page: HexColor;
  surface: HexColor;
  text: HexColor;
  muted?: HexColor;
  gradient?: { from: HexColor; to: HexColor; angle: number };
}

export interface ThemePreset {
  id: string;
  name: string;
  layout: Theme['layout'];
  tokens: ThemeTokens;
}

const colors = (scheme: ColorScheme): ThemeTokens['colors'] => ({
  page: scheme.page,
  surface: scheme.surface,
  text: scheme.text,
  muted: scheme.muted ?? hex('#6b6a66'),
  accent: scheme.accent,
  inputBg: scheme.surface,
  inputText: scheme.text,
});

const backgroundOf = (scheme: ColorScheme): NonNullable<ThemeTokens['background']> =>
  scheme.gradient
    ? { kind: 'gradient', from: scheme.gradient.from, to: scheme.gradient.to, angle: scheme.gradient.angle }
    : { kind: 'color', color: scheme.page };

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  /* The Default theme: the design system's primary blue (Figma interactive/bg/primary), as on a new form's Submit. */
  { id: 'paper', name: 'Paper', accent: hex('#2950da'), page: hex('#e3eaf3'), surface: hex('#ffffff'), text: hex('#1c1917') },
  { id: 'ocean', name: 'Ocean', accent: hex('#0f766e'), page: hex('#ccfbf1'), surface: hex('#ffffff'), text: hex('#134e4a') },
  { id: 'sunset', name: 'Sunset', accent: hex('#ea580c'), page: hex('#ffedd5'), surface: hex('#fff7ed'), text: hex('#7c2d12'), gradient: { from: hex('#fdba74'), to: hex('#fed7aa'), angle: 160 } },
  { id: 'sand', name: 'Sand', accent: hex('#b45309'), page: hex('#f5e6c8'), surface: hex('#fffaf0'), text: hex('#44403c') },
  { id: 'meadow', name: 'Meadow', accent: hex('#15803d'), page: hex('#dcfce7'), surface: hex('#ffffff'), text: hex('#14532d') },
  { id: 'ink', name: 'Ink', accent: hex('#e2e8f0'), page: hex('#0f172a'), surface: hex('#1e293b'), text: hex('#e2e8f0'), muted: hex('#94a3b8') },
  { id: 'rose', name: 'Rose', accent: hex('#be123c'), page: hex('#ffe4e6'), surface: hex('#fff1f2'), text: hex('#4c0519') },
  { id: 'sky', name: 'Sky', accent: hex('#2563eb'), page: hex('#dbeafe'), surface: hex('#ffffff'), text: hex('#1e3a8a') },
  { id: 'violet', name: 'Violet', accent: hex('#7c3aed'), page: hex('#ede9fe'), surface: hex('#ffffff'), text: hex('#3b0764'), gradient: { from: hex('#c4b5fd'), to: hex('#ddd6fe'), angle: 140 } },
  { id: 'snow', name: 'Snow', accent: hex('#111827'), page: hex('#f8fafc'), surface: hex('#ffffff'), text: hex('#111827') },
  { id: 'coral', name: 'Coral', accent: hex('#db2777'), page: hex('#fce7f3'), surface: hex('#ffffff'), text: hex('#831843') },
  { id: 'citrus', name: 'Citrus', accent: hex('#ca8a04'), page: hex('#fef9c3'), surface: hex('#fffbeb'), text: hex('#422006') },
];

const tokens = (
  scheme: ColorScheme,
  extra: Partial<Omit<ThemeTokens, 'colors' | 'background'>> = {},
): ThemeTokens => ({
  colors: colors(scheme),
  typography: extra.typography ?? { body: font('inter'), baseSizePx: 16 },
  radius: extra.radius ?? 'md',
  density: extra.density ?? 'comfortable',
  formWidth: extra.formWidth ?? 'normal',
  labelAlign: extra.labelAlign ?? 'top',
  inputStyle: extra.inputStyle ?? 'outlined',
  progress: extra.progress ?? 'none',
  background: backgroundOf(scheme),
});

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'default', name: 'Default', layout: 'classic', tokens: tokens(COLOR_SCHEMES[0] as ColorScheme) },
  { id: 'harbor', name: 'Harbor', layout: 'classic', tokens: tokens(COLOR_SCHEMES[1] as ColorScheme, { radius: 'lg' }) },
  { id: 'afterglow', name: 'Afterglow', layout: 'classic', tokens: tokens(COLOR_SCHEMES[2] as ColorScheme, { radius: 'lg', typography: { body: font('georgia'), baseSizePx: 17 } }) },
  { id: 'dune', name: 'Dune', layout: 'classic', tokens: tokens(COLOR_SCHEMES[3] as ColorScheme, { radius: 'sm', typography: { body: font('georgia'), baseSizePx: 16 } }) },
  { id: 'grove', name: 'Grove', layout: 'classic', tokens: tokens(COLOR_SCHEMES[4] as ColorScheme, { radius: 'full' }) },
  { id: 'midnight', name: 'Midnight', layout: 'classic', tokens: tokens(COLOR_SCHEMES[5] as ColorScheme, { radius: 'md', inputStyle: 'filled' }) },
  { id: 'petal', name: 'Petal', layout: 'cards', tokens: tokens(COLOR_SCHEMES[6] as ColorScheme, { radius: 'lg', density: 'spacious' }) },
  { id: 'clearsky', name: 'Clear sky', layout: 'classic', tokens: tokens(COLOR_SCHEMES[7] as ColorScheme, { formWidth: 'wide' }) },
  { id: 'iris', name: 'Iris', layout: 'cards', tokens: tokens(COLOR_SCHEMES[8] as ColorScheme, { radius: 'lg', density: 'spacious' }) },
  { id: 'ledger', name: 'Ledger', layout: 'classic', tokens: tokens(COLOR_SCHEMES[9] as ColorScheme, { radius: 'none', formWidth: 'narrow', typography: { body: font('mono'), baseSizePx: 15 } }) },
  { id: 'bloom', name: 'Bloom', layout: 'classic', tokens: tokens(COLOR_SCHEMES[10] as ColorScheme, { radius: 'full' }) },
  { id: 'sunroom', name: 'Sunroom', layout: 'classic', tokens: tokens(COLOR_SCHEMES[11] as ColorScheme, { radius: 'lg', typography: { body: font('georgia'), baseSizePx: 18 } }) },
];

export function applyScheme(theme: Theme, scheme: ColorScheme): Theme {
  return {
    ...theme,
    tokens: {
      ...theme.tokens,
      colors: { ...theme.tokens.colors, ...colors(scheme) },
      background: backgroundOf(scheme),
    },
  };
}

export interface ImageTemplate {
  id: string;
  name: string;
  scene: string;
  cover: string;
  layout: Theme['layout'];
  scheme: ColorScheme;
}

const schemeById = (id: string) => COLOR_SCHEMES.find((scheme) => scheme.id === id) as ColorScheme;

/** Full-bleed looks: a page photograph, a cover band, and a matching palette. */
export const IMAGE_TEMPLATES: readonly ImageTemplate[] = [
  { id: 'tpl-coast', name: 'Coastal survey', scene: 'scene-coast', cover: 'scene-coast', layout: 'classic', scheme: schemeById('ocean') },
  { id: 'tpl-dunes', name: 'Desert retreat', scene: 'scene-dunes', cover: 'scene-dunes', layout: 'classic', scheme: schemeById('sunset') },
  { id: 'tpl-forest', name: 'Field study', scene: 'scene-forest', cover: 'scene-forest', layout: 'cards', scheme: schemeById('meadow') },
  { id: 'tpl-city', name: 'After hours', scene: 'scene-city', cover: 'scene-city', layout: 'classic', scheme: schemeById('ink') },
  { id: 'tpl-studio', name: 'Client intake', scene: 'scene-studio', cover: 'scene-studio', layout: 'classic', scheme: schemeById('snow') },
  { id: 'tpl-bloom', name: 'Event RSVP', scene: 'scene-bloom', cover: 'scene-bloom', layout: 'cards', scheme: schemeById('rose') },
  { id: 'tpl-aurora', name: 'Product feedback', scene: 'scene-aurora', cover: 'scene-aurora', layout: 'classic', scheme: schemeById('violet') },
  { id: 'tpl-summit', name: 'Registration', scene: 'scene-summit', cover: 'scene-summit', layout: 'classic', scheme: schemeById('sky') },
  { id: 'tpl-botanical', name: 'Workshop', scene: 'scene-botanical', cover: 'scene-botanical', layout: 'cards', scheme: schemeById('meadow') },
  { id: 'tpl-confetti', name: 'Celebration', scene: 'scene-confetti', cover: 'scene-confetti', layout: 'classic', scheme: schemeById('sunset') },
  { id: 'tpl-ink', name: 'Portfolio', scene: 'scene-ink', cover: 'scene-ink', layout: 'classic', scheme: schemeById('ink') },
  { id: 'tpl-citrus', name: 'Order form', scene: 'scene-citrus', cover: 'scene-citrus', layout: 'classic', scheme: schemeById('citrus') },
];

export function applyImageTemplate(theme: Theme, template: ImageTemplate): Theme {
  const base = applyPreset(theme, { id: template.id, name: template.name, layout: template.layout, tokens: tokens(template.scheme, { radius: 'lg' }) });
  return {
    ...base,
    tokens: {
      ...base.tokens,
      background: { kind: 'image', image: { assetId: template.scene as never, decorative: true }, fit: 'cover' },
      cover: { image: { assetId: template.cover as never, decorative: true }, heightPx: 220 },
    },
  };
}

export function applyPreset(theme: Theme, preset: ThemePreset): Theme {
  return { ...theme, layout: preset.layout, tokens: { ...preset.tokens, colors: { ...preset.tokens.colors } } };
}

export function matchingSchemeId(theme: Theme): string | undefined {
  const accent = theme.tokens.colors.accent;
  const page = theme.tokens.colors.page;
  return COLOR_SCHEMES.find((s) => s.accent === accent && s.page === page)?.id;
}

export function matchingPresetId(theme: Theme): string | undefined {
  const background = theme.tokens.background;
  if (background?.kind === 'image') {
    return IMAGE_TEMPLATES.find((template) => template.scene === background.image.assetId && template.layout === theme.layout)?.id;
  }
  const accent = theme.tokens.colors.accent;
  const page = theme.tokens.colors.page;
  return THEME_PRESETS.find((p) => p.tokens.colors.accent === accent && p.tokens.colors.page === page && p.layout === theme.layout)?.id;
}
