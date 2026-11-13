import type { AssetRef, FontId, HexColor, PurposeId, TemplateId, TemplateVersionId, TimeZone } from './ids.ts';
import type { LabelText, ThemeColorToken } from './rich-text.ts';
import type { BrandRef } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §11  THEME AND BEHAVIOUR (published)
 * ═════════════════════════════════════════════════════════════════════════ */

/** DSN-01..06 → CSS custom properties under `.fr-root`. Values may be brand refs (resolved at publish). */
export interface ThemeTokens {
  colors: Partial<Record<ThemeColorToken, HexColor | BrandRef>>;
  typography: { body: FontId | BrandRef; heading?: FontId | BrandRef; baseSizePx: number }; // self-hosted (DSN-06)
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full' | BrandRef;
  density: 'compact' | 'comfortable' | 'spacious';
  formWidth: 'narrow' | 'normal' | 'wide';
  labelAlign: 'top' | 'left' | 'right';
  inputStyle: 'outlined' | 'filled' | 'underlined';
  progress: 'none' | 'bar' | 'steps' | 'percent';
  logo?: { image: AssetRef | BrandRef; position: 'left' | 'center' | 'right' };
  cover?: { image: AssetRef; heightPx: number };
  background?: { kind: 'color'; color: HexColor | BrandRef } | { kind: 'gradient'; from: HexColor | BrandRef; to: HexColor | BrandRef; angle: number } | { kind: 'image'; image: AssetRef; fit: 'cover' | 'contain' | 'tile' };
}
export interface Theme {
  /** Theme template this came from (lineage lives in bindings; this is for the Design panel). */
  presetRef?: { templateId: TemplateId; versionId: TemplateVersionId };
  layout: 'classic' | 'cards';       // DSN-05
  tokens: ThemeTokens;
  /** DSN-04: scoped under .fr-root; @import, external url(), expression() rejected; ≤ 50 KB. */
  customCss?: string;
}

export const SECTION_NAV_PLACEMENTS = ['top', 'bottom', 'left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
export type SectionNavPlacement = (typeof SECTION_NAV_PLACEMENTS)[number];
export const SECTION_NAV_VARIANTS = ['stepper', 'pills', 'dots', 'numbers', 'breadcrumb', 'timeline'] as const;
export type SectionNavVariant = (typeof SECTION_NAV_VARIANTS)[number];
export const SECTION_NAV_CURRENT = ['color', 'fill', 'pulse', 'underline', 'bold'] as const;
export type SectionNavCurrentMarker = (typeof SECTION_NAV_CURRENT)[number];
export const SECTION_NAV_COMPLETED = ['check', 'muted', 'keep'] as const;
export type SectionNavCompletedMarker = (typeof SECTION_NAV_COMPLETED)[number];
export const SECTION_NAV_CONNECTORS = ['arrow', 'line', 'chevron', 'none'] as const;
export type SectionNavConnector = (typeof SECTION_NAV_CONNECTORS)[number];
export const SECTION_NAV_CHROMES = ['plain', 'cards', 'circles', 'bar'] as const;
export type SectionNavChrome = (typeof SECTION_NAV_CHROMES)[number];
export const SECTION_NAV_MODES = ['scroll', 'paged'] as const;
export type SectionNavMode = (typeof SECTION_NAV_MODES)[number];

/** How named section breaks appear to the respondent (Personal information → Education → Payment → Submit). */
export interface SectionNav {
  enabled: boolean;
  /** `scroll`: one page, click jumps to the marker. `paged`: each marker starts a new page. */
  mode: SectionNavMode;
  placement: SectionNavPlacement;
  variant: SectionNavVariant;
  currentMarker: SectionNavCurrentMarker;
  completedMarker: SectionNavCompletedMarker;
  connector: SectionNavConnector;
  size: 'sm' | 'md' | 'lg';
  /** Label size in px (single-page navigator). */
  labelSizePx?: number;
  /** Navigator / current-step colour. */
  color?: HexColor;
  /** Label colour (single-page). */
  labelColor?: HexColor;
  sticky: boolean;
  clickable: boolean;
  showIndex: boolean;
  includeSubmit: boolean;
  submitLabel?: string;
  align: 'start' | 'center' | 'end';
  /** Frame around the steps: plain text, bordered cards, circles, or a full bar. */
  chrome?: SectionNavChrome;
}

export const DEFAULT_SECTION_NAV: SectionNav = {
  enabled: true,
  mode: 'scroll',
  placement: 'top',
  variant: 'stepper',
  currentMarker: 'color',
  completedMarker: 'check',
  connector: 'arrow',
  size: 'md',
  sticky: false,
  clickable: true,
  showIndex: false,
  includeSubmit: true,
  align: 'center',
  chrome: 'cards',
};

export const SUBMIT_BUTTON_SIZES = ['sm', 'md', 'lg'] as const;
export type SubmitButtonSize = (typeof SUBMIT_BUTTON_SIZES)[number];
export const SUBMIT_BUTTON_SHAPES = ['square', 'rounded', 'pill'] as const;
export type SubmitButtonShape = (typeof SUBMIT_BUTTON_SHAPES)[number];

export interface SubmitButtonStyle {
  bgColor?: HexColor;
  textColor?: HexColor;
  size?: SubmitButtonSize;
  shape?: SubmitButtonShape;
}

export interface Behavior {
  submit: { label: LabelText; align: 'left' | 'center' | 'right' | 'full'; printButton?: boolean } & SubmitButtonStyle; // FLD-50
  navigation: { allowBack: boolean; showPageTitles: boolean; autoAdvance?: boolean; keyboardShortcuts?: boolean };
  /** Present when the form uses section breaks; omitted on older forms. */
  sectionNav?: SectionNav;
  saveAndResume: { enabled: boolean; showButton: boolean; delivery: Array<'email' | 'copy_link'>; expiryDays: number }; // RSP-03 (≤ 60)
  /** RSP-04: forced off when any field is 'sensitive' unless allowWithSensitive; always off for consent-based fields before consent and under a children policy. */
  localAutosave: { enabled: boolean; allowWithSensitive: boolean };
  timeZone: TimeZone;                 // form tz for dates, age, windows
  spam: { honeypot: boolean; minFillSeconds: number; captcha: 'off' | 'always' | 'on_suspicion' }; // SPM-01, FLD-29; a captcha block overrides this
  /** ANA-05: off by default, consent-gated, disabled for minors and on air-gapped editions. */
  analytics?: { ga4?: string; gtm?: string; metaPixel?: string; requiresPurposeId: PurposeId };
  allowRespondentEdit?: { enabled: boolean; windowHours?: number };           // RSP-09
  urlPrefill: boolean;                                                         // PRE-01
  /** DSN-07: plan-gated request; server decides. */
  showBranding: boolean;
  a11y: { announceErrors: 'polite' | 'assertive'; focusFirstError: boolean };
  successAnimation: boolean;          // DSN-11, respects prefers-reduced-motion
}
