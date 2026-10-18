import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat, type Formatters } from 'intl-messageformat';
import { SOURCE_LOCALE } from './catalogs';
import {
  EN_DATE_NAMES,
  formatDate,
  formatDateTime,
  formatTime,
  type DateFormatOptions,
  type DateNames,
  type DatePattern,
  type HourCycle,
} from './date';
import { parseMessage } from './icu';
import { splitMessageId, type Catalog, type Catalogs, type MessageId, type Namespace } from './messages';
import { formatMoney, type MinorUnitsInput, type MoneyFormatOptions } from './money';
import { defaultGrouping, formatNumber, type NumberFormatOptions, type NumericInput } from './number';
import { isPseudoLocale, pseudoLocalizeAst } from './pseudo';

export type MessageValues = Readonly<Record<string, string | number>>;

export type I18nError =
  | { kind: 'locale'; locale: string; message: string }
  | { kind: 'missing'; locale: string; id: string }
  | { kind: 'syntax' | 'format'; locale: string; id: string; message: string };

export interface I18nOptions {
  /** Consulted when a key is missing from `catalogs`, typically the en-IN source catalogues. */
  fallback?: Catalogs;
  /**
   * An invalid or unsupported locale tag (formatting then uses en-IN), missing keys, ICU syntax errors
   * (including date, time and styled number arguments) and missing or non-numeric values, reported on
   * every affected call; `createI18n` and `t` never throw.
   */
  onError?: (error: I18nError) => void;
}

export interface I18n {
  readonly locale: string;
  /** Locale used for plural rules (`en-IN` under `en-XA` or for an invalid or unsupported tag). */
  readonly formatLocale: string;
  /** Formats a message; on any problem reports through `onError` and returns the id. */
  t(id: MessageId, values?: MessageValues): string;
  has(id: MessageId): boolean;
  /** Keys absent from this locale's own catalogue (fallback not consulted). */
  missing(namespace: Namespace, keys: Iterable<string>): string[];
  readonly dateNames: DateNames;
  formatNumber(value: NumericInput, options?: NumberFormatOptions): string;
  formatMoney(minor: MinorUnitsInput, currency: string, options?: MoneyFormatOptions): string;
  formatDate(value: string, pattern: DatePattern, options?: Omit<DateFormatOptions, 'names'>): string;
  formatTime(value: string, hourCycle: HourCycle): string;
  formatDateTime(value: string, pattern: DatePattern, hourCycle: HourCycle, options?: Omit<DateFormatOptions, 'names'>): string;
}

/** ICU argument names cannot contain `:`, so these never clash with caller values. */
const plainKey = (name: string) => `plain:${name}`;

/**
 * intl-messageformat prints a plain `{n}` with `String(n)`. Points plain arguments at a derived
 * value so numbers go through the same formatter as `#` and `{n, number}`, while plural and select
 * still see the raw number.
 */
function redirectPlainArguments(elements: MessageFormatElement[], names: Set<string>): MessageFormatElement[] {
  return elements.map((element): MessageFormatElement => {
    switch (element.type) {
      case TYPE.argument:
        names.add(element.value);
        return { ...element, value: plainKey(element.value) };
      case TYPE.plural:
      case TYPE.select: {
        const options: typeof element.options = {};
        for (const [key, option] of Object.entries(element.options)) {
          options[key] = { ...option, value: redirectPlainArguments(option.value, names) };
        }
        return { ...element, options };
      }
      case TYPE.tag:
        return { ...element, children: redirectPlainArguments(element.children, names) };
      default:
        return element;
    }
  });
}

type Compiled = { format: IntlMessageFormat; args: readonly string[]; plain: readonly string[] } | { error: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function validFormatLocale(locale: string, report: (error: I18nError) => void): string {
  if (isPseudoLocale(locale)) return SOURCE_LOCALE;
  let message: string;
  try {
    Intl.getCanonicalLocales(locale);
    if (Intl.PluralRules.supportedLocalesOf(locale).length > 0) return locale;
    message = `${locale} has no plural rules in this runtime`;
  } catch (error) {
    message = errorMessage(error);
  }
  report({ kind: 'locale', locale, message });
  return SOURCE_LOCALE;
}

function lookup(catalogs: Catalogs | undefined, namespace: Namespace, key: string): string | undefined {
  const catalog: Catalog | undefined = catalogs?.[namespace];
  return catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

export function createI18n(locale: string, catalogs: Catalogs, options: I18nOptions = {}): I18n {
  const pseudo = isPseudoLocale(locale);
  const report = (error: I18nError) => options.onError?.(error);
  const formatLocale = validFormatLocale(locale, report);
  const grouping = defaultGrouping(locale);
  const compiled = new Map<string, Compiled>();

  /** Every number in a message (`{n}`, `#`, `{n, number}`) goes through this one locale-independent path. */
  const formatArgument = (value: unknown): string => {
    const out = typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' ? formatNumber(value, { grouping }) : '';
    if (out === '') throw new TypeError(`${String(value)} is not a number`);
    return out;
  };
  const pluralRules = new Map<string, Intl.PluralRules>();
  const formatters: Formatters = {
    getNumberFormat: () => ({ format: formatArgument }) as unknown as Intl.NumberFormat,
    getDateTimeFormat: () => {
      throw new TypeError('date and time arguments are not supported');
    },
    getPluralRules: (_locales, opts) => {
      const type = opts?.type ?? 'cardinal';
      let rules = pluralRules.get(type);
      if (!rules) pluralRules.set(type, (rules = new Intl.PluralRules(formatLocale, { type })));
      return rules;
    },
  };

  const compile = (id: string, source: string): Compiled => {
    let result = compiled.get(id);
    if (!result) {
      try {
        const parsed = parseMessage(source);
        const plain = new Set<string>();
        let ast = redirectPlainArguments(parsed.ast, plain);
        if (pseudo) ast = pseudoLocalizeAst(ast);
        const format = new IntlMessageFormat(ast, formatLocale, undefined, { ignoreTag: true, formatters });
        result = { format, args: parsed.args, plain: [...plain] };
      } catch (error) {
        result = { error: errorMessage(error) };
      }
      compiled.set(id, result);
    }
    return result;
  };

  const resolve = (id: string): string | undefined => {
    const parts = splitMessageId(id);
    if (!parts) return undefined;
    return lookup(catalogs, parts.namespace, parts.key) ?? lookup(options.fallback, parts.namespace, parts.key);
  };

  const t = (id: MessageId, values?: MessageValues): string => {
    const source = resolve(id);
    if (source === undefined) {
      report({ kind: 'missing', locale, id });
      return id;
    }
    const compiledMessage = compile(id, source);
    if ('error' in compiledMessage) {
      report({ kind: 'syntax', locale, id, message: compiledMessage.error });
      return id;
    }
    const absent = compiledMessage.args.filter((name) => values?.[name] === undefined);
    if (absent.length) {
      report({ kind: 'format', locale, id, message: `Missing value for ${absent.map((name) => `{${name}}`).join(', ')}` });
      return id;
    }
    try {
      const args: Record<string, string | number> = { ...values };
      for (const name of compiledMessage.plain) {
        const value = values?.[name];
        if (value !== undefined) args[plainKey(name)] = typeof value === 'number' ? formatArgument(value) : value;
      }
      const out = compiledMessage.format.format<string>(args);
      return Array.isArray(out) ? out.join('') : String(out);
    } catch (error) {
      report({ kind: 'format', locale, id, message: errorMessage(error) });
      return id;
    }
  };

  const name = (key: string, fallback: string): string => (resolve(`system:${key}`) === undefined ? fallback : t(`system:${key}`));
  const months = (kind: 'short' | 'long', fallback: readonly string[]) =>
    fallback.map((english, i) => name(`date.month_${kind}.${i + 1}`, english));
  let names: DateNames | undefined;
  const dateNames = (): DateNames =>
    (names ??= {
      monthsShort: months('short', EN_DATE_NAMES.monthsShort),
      monthsLong: months('long', EN_DATE_NAMES.monthsLong),
      am: name('time.am', EN_DATE_NAMES.am),
      pm: name('time.pm', EN_DATE_NAMES.pm),
    });

  return {
    locale,
    formatLocale,
    t,
    has: (id) => resolve(id) !== undefined,
    missing: (namespace, keys) => [...keys].filter((key) => lookup(catalogs, namespace, key) === undefined),
    get dateNames() {
      return dateNames();
    },
    formatNumber: (value, opts = {}) => formatNumber(value, { grouping, ...opts }),
    formatMoney: (minor, currency, opts = {}) => formatMoney(minor, currency, { grouping, ...opts }),
    formatDate: (value, pattern, opts = {}) => formatDate(value, pattern, { ...opts, names: dateNames() }),
    formatTime: (value, hourCycle) => formatTime(value, hourCycle, dateNames()),
    formatDateTime: (value, pattern, hourCycle, opts = {}) =>
      formatDateTime(value, pattern, hourCycle, { ...opts, names: dateNames() }),
  };
}
