import { VALIDATION_ERROR_CODES } from './envelope.ts';
import type { Locale, Sha256Hex } from './ids.ts';
import type { InlineDoc, PlainTemplate, RichDoc } from './rich-text.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §12  I18N (FND-12, RSP-05, VAL-08) — same shape for forms and template payloads
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Stable id-path keys (survive reordering and label edits):
 *   form:title|description · welcome:content|startLabel · page:<pageId>:title|next|back
 *   block:<blockId>:label|description|placeholder|prefix|suffix|text|subheading|content|sub:<part>|msg:<code>
 *   option:<blockId>/<optionId> · mrow:<blockId>/<rowId> · mcol:<blockId>/<colId>
 *   product:<blockId>/<productId>:name|description · purpose:<purposeId>:name|description
 *   consent:<blockId>:notice|withdrawal|item:<itemId> · ending:<endingId>:content|message|url|action:<i>
 *   rule:<ruleId>:<actionIndex> · behavior:submit · tplvar:<name>:label|help   (template payloads only)
 */
export type TextKey = `${'form' | 'welcome' | 'page' | 'block' | 'option' | 'mrow' | 'mcol' | 'product' | 'purpose' | 'consent' | 'ending' | 'rule' | 'behavior' | 'tplvar'}:${string}`;

export interface TranslationEntry {
  value: string | InlineDoc | RichDoc | PlainTemplate;
  /** Hash of the default-locale source at translation time → stale detection + completeness. */
  sourceHash: Sha256Hex;
  origin: 'human' | 'machine' | 'import' | 'template';
}

export const SYSTEM_MESSAGE_KEYS = [
  ...VALIDATION_ERROR_CODES,
  'nav.next', 'nav.back', 'nav.submit', 'nav.save_later', 'nav.start', 'select.placeholder', 'select.no_results',
  'other.label', 'other.placeholder', 'file.drop_here', 'signature.clear', 'group.add_row', 'group.remove_row',
  'form.closed', 'form.not_open_yet', 'form.limit_reached', 'form.password_prompt', 'form.already_submitted',
  'resume.continue_or_restart', 'resume.link_sent', 'progress.label',
] as const;
export type SystemMessageKey = (typeof SYSTEM_MESSAGE_KEYS)[number];

export interface I18nBundle {
  defaultLocale: Locale;
  locales: Array<{ locale: Locale; direction: 'ltr' | 'rtl' }>;   // includes default
  detect: Array<'url_param' | 'browser' | 'embed_attr'>;
  urlParam: string;                                               // ?lang=hi-IN
  switcher: 'none' | 'dropdown';
  /** Non-default locales only; default-locale text lives inline. */
  messages: Partial<Record<Locale, Partial<Record<TextKey, TranslationEntry>>>>;
  systemMessages: Partial<Record<Locale, Partial<Record<SystemMessageKey, string>>>>;
  /** Consent notices must be human-reviewed per locale before publish. */
  reviewedConsentLocales: Locale[];
}
