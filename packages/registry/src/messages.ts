import { EN_IN, createI18n, defineMessages, type I18n, type MessageId, type MessageValues } from '@form/i18n';
import type { CountryCode, DatePattern, Locale } from '@form/schema';

export const PALETTE_LABELS = defineMessages('builder', {
  'palette.short_text': 'Short answer',
  'palette.long_text': 'Long answer',
  'palette.email': 'Email',
  'palette.phone': 'Phone',
  'palette.number': 'Number',
  'palette.url': 'Link',
  'palette.single_choice.radio': 'Single choice',
  'palette.single_choice.dropdown': 'Dropdown',
  'palette.multi_choice.checkbox': 'Checkboxes',
  'palette.multi_choice.dropdown': 'Multi-select dropdown',
  'palette.date': 'Date',
  'palette.time': 'Time',
  'palette.rating': 'Rating',
  'palette.linear_scale': 'Linear scale',
  'palette.nps': 'Net Promoter Score',
  'palette.ranking': 'Ranking',
  'palette.matrix': 'Input table',
  'palette.full_name': 'Full name',
  'palette.long_text.address': 'Address',
  'palette.single_choice.gender': 'Gender',
  'palette.single_choice.yes_no': 'Yes / No',
  'palette.file_upload': 'File upload',
  'palette.signature': 'Signature',
  'palette.hidden': 'Hidden field',
  'palette.heading': 'Heading',
  'palette.paragraph': 'Text',
  'palette.divider': 'Divider',
});

export const DEFAULT_TEXT = defineMessages('builder', {
  'defaults.option': 'Option {n}',
  'defaults.matrix_row': 'Row {n}',
  'defaults.matrix_column': 'Column {n}',
  'defaults.terms_item': 'I agree to the terms and conditions',
});

const MAX_CACHED = 32;
const instances = new Map<string, I18n>();

/** en-IN source text, formatted for `locale` (the catalogues other locales add later plug in here). */
export function message(locale: Locale, id: MessageId, values?: MessageValues): string {
  let i18n = instances.get(locale);
  if (!i18n) {
    if (instances.size >= MAX_CACHED) instances.clear();
    i18n = createI18n(locale, EN_IN);
    instances.set(locale, i18n);
  }
  return i18n.t(id, values);
}

const REGION = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?-([A-Z]{2})(?:-|$)/;
const H12_REGIONS: ReadonlySet<string> = new Set(['IN', 'US', 'CA', 'AU', 'NZ', 'PH', 'PK', 'BD', 'EG', 'SA']);

/** Region subtag of a BCP-47 tag; `IN` when the tag has none. */
export const regionOf = (locale: Locale): CountryCode => (REGION.exec(locale)?.[1] ?? 'IN') as CountryCode;

export const datePatternFor = (locale: Locale): DatePattern => (regionOf(locale) === 'US' ? 'MM/DD/YYYY' : 'DD-MM-YYYY');

export const hourCycleFor = (locale: Locale): 'h12' | 'h23' => (H12_REGIONS.has(regionOf(locale)) ? 'h12' : 'h23');
