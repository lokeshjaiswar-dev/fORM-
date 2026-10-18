import { EN_IN, createI18n, type I18n, type MessageValues } from '@form/i18n';
import type { EvaluableVersion } from '@form/logic';
import type { EvalState, FieldBlock, Locale, ValidationErrorCode } from '@form/schema';

/*
 * Message text for a FieldError, most specific first (VAL-07, VAL-08):
 *   1. the block's own message for the code (`block.messages[code]`; in another locale its `block:<id>:msg:<code>` translation);
 *   2. the form's system message override for the locale (`i18n.systemMessages[locale][code]`);
 *   3. the caller's catalogues (`messages`), then the en-IN source catalogue of @form/i18n.
 * Every level is ICU MessageFormat with the same arguments; a level that fails to format falls through.
 */

type Definition = EvaluableVersion['definition'];

export interface MessageFormatter {
  format(code: ValidationErrorCode, values: MessageValues, block?: FieldBlock): string;
  /** Formats a decimal or count for a message argument with the locale's grouping. */
  number(value: string | number): string;
}

const SOURCE = new Map<string, I18n>();
const sourceI18n = (locale: string): I18n => {
  let i18n = SOURCE.get(locale);
  if (!i18n) SOURCE.set(locale, (i18n = createI18n(locale, EN_IN)));
  return i18n;
};

const blockKey = (blockId: string, code: string) => `block:${blockId}:msg:${code}`;

/** The form's own texts for `locale` as one `system` catalogue: system overrides by code, block messages by key. */
function formCatalog(def: Definition, locale: Locale): Record<string, string> {
  const catalog: Record<string, string> = {};
  const overrides = def.i18n.systemMessages[locale] ?? {};
  for (const [code, text] of Object.entries(overrides)) if (typeof text === 'string') catalog[code] = text;
  const translations = locale === def.i18n.defaultLocale ? undefined : def.i18n.messages[locale];
  for (const block of Object.values(def.blocks)) {
    if (!block || !('messages' in block) || !block.messages) continue;
    for (const [code, text] of Object.entries(block.messages)) {
      const translated = translations?.[blockKey(block.id, code) as `block:${string}`]?.value;
      const source = typeof translated === 'string' ? translated : text;
      if (typeof source === 'string' && source.trim() !== '') catalog[blockKey(block.id, code)] = source;
    }
  }
  return catalog;
}

const FORMS = new WeakMap<object, Map<string, I18n>>();
function formI18n(def: Definition, locale: Locale): I18n {
  let byLocale = FORMS.get(def);
  if (!byLocale) FORMS.set(def, (byLocale = new Map()));
  let i18n = byLocale.get(locale);
  if (!i18n) byLocale.set(locale, (i18n = createI18n(locale, { system: formCatalog(def, locale) })));
  return i18n;
}

/** Formats `id`, or undefined when the catalogue lacks it or it fails to format (`t` then returns the id). */
function attempt(i18n: I18n, id: `system:${string}`, values: MessageValues): string | undefined {
  if (!i18n.has(id)) return undefined;
  const out = i18n.t(id, values);
  return out === id ? undefined : out;
}

/**
 * The text of a logic `submitBlock` in `locale` (schema §3.3, block_submit): its `rule:<ruleId>:<actionIndex>`
 * translation, where the index counts the rule's `then` actions and then its `else` actions, or the message
 * as written. Rule messages are plain text, not ICU.
 */
export function submitBlockMessage(def: Definition, locale: Locale, entry: EvalState['submitBlocks'][number]): string {
  if (locale === def.i18n.defaultLocale) return entry.message;
  const rule = def.logic.rules.find((r) => r.id === entry.ruleId);
  const index = (rule ? [...rule.then, ...(rule.else ?? [])] : []).findIndex((action) =>
    action.type === 'block_submit' && action.message === entry.message && action.atPage === entry.atPage && action.anchorBlockId === entry.anchorBlockId);
  const translated = index < 0 ? undefined : def.i18n.messages[locale]?.[`rule:${entry.ruleId}:${index}`]?.value;
  return typeof translated === 'string' && translated.trim() !== '' ? translated : entry.message;
}

export function messageFormatter(def: Definition, locale: Locale, messages?: I18n): MessageFormatter {
  const form = formI18n(def, locale);
  const source = sourceI18n(locale);
  return {
    format(code, values, block) {
      return (block ? attempt(form, `system:${blockKey(block.id, code)}`, values) : undefined)
        ?? attempt(form, `system:${code}`, values)
        ?? (messages ? attempt(messages, `system:${code}`, values) : undefined)
        ?? attempt(source, `system:${code}`, values)
        ?? source.t('system:invalid_format');
    },
    number: (value) => (messages ?? source).formatNumber(value),
  };
}
