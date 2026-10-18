import { z } from 'zod';
import { keyed } from './_util.ts';
import { SYSTEM_MESSAGE_KEYS } from '../i18n.ts';
import { LocaleSchema, Sha256HexSchema } from './primitives.ts';
import { InlineDocSchema, PlainTemplateSchema, RichDocSchema } from './rich-text.ts';

const TEXT_KEY_SCOPES = ['form', 'welcome', 'page', 'block', 'option', 'mrow', 'mcol', 'product', 'purpose', 'consent', 'ending', 'rule', 'behavior', 'tplvar'] as const;
export const TextKeySchema = z.templateLiteral([z.enum(TEXT_KEY_SCOPES), ':', z.string()]);

export const TranslationEntrySchema = z.object({
  value: z.union([z.string(), InlineDocSchema, RichDocSchema, PlainTemplateSchema]),
  sourceHash: Sha256HexSchema,
  origin: z.enum(['human', 'machine', 'import', 'template']),
});

export const SystemMessageKeySchema = z.enum(SYSTEM_MESSAGE_KEYS);

export const I18nBundleSchema = z.object({
  defaultLocale: LocaleSchema,
  locales: z.array(z.object({ locale: LocaleSchema, direction: z.enum(['ltr', 'rtl']) })).min(1),
  detect: z.array(z.enum(['url_param', 'browser', 'embed_attr'])),
  urlParam: z.string().min(1).max(32),
  switcher: z.enum(['none', 'dropdown']),
  messages: keyed(z.partialRecord(LocaleSchema, keyed(z.partialRecord(TextKeySchema, TranslationEntrySchema)))),
  systemMessages: keyed(z.partialRecord(LocaleSchema, keyed(z.partialRecord(SystemMessageKeySchema, z.string().max(1000))))),
  reviewedConsentLocales: z.array(LocaleSchema),
});
