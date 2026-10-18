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

export interface Behavior {
  submit: { label: LabelText; align: 'left' | 'center' | 'right' | 'full'; printButton?: boolean }; // FLD-50
  navigation: { allowBack: boolean; showPageTitles: boolean; autoAdvance?: boolean; keyboardShortcuts?: boolean };
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
