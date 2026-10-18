import type { TemplateBindingId } from './ids.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  TEMPLATE-AWARE PRIMITIVES (used throughout; full template model in §17)
 * ═════════════════════════════════════════════════════════════════════════ */

/** `org.legal_name`, `brand.primary`, `form.retention_days`, `custom.event_name`. */
export type TemplateVariableName = `${'org' | 'brand' | 'form' | 'custom'}.${string}`;
/** Brand-kit token reference used in theme / email / PDF (§17.3). */
export type BrandToken =
  | 'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text' | 'muted' | 'error' | 'success'
  | 'logo' | 'logo_dark' | 'logo_square' | 'favicon' | 'font_heading' | 'font_body' | 'radius';
export interface BrandRef { ref: `brand.${BrandToken}` }

/**
 * Lineage stamp on every block, page, rule, variable, ending, notification, PDF and status
 * screen that came from a template. Invisible to respondents; stripped from the runtime
 * projection; used by the 3-way template diff (§17.6) and lock fingerprints (§17.4).
 */
export interface Origin {
  bindingId: TemplateBindingId;
  /** Id of the same item inside the template version payload. */
  sourceId: string;
}
