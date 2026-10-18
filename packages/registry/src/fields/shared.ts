import { jsonPointer } from '@form/schema';
import type {
  BlockConfigMap, BlockId, BlockType, ChoiceOption, DecimalString, Locale, OptionId, OtherOption, PaletteEntry, PublishIssue, ScalarValue, TextKey,
} from '@form/schema';
import { issue, type Report } from '../define.ts';
import { DEFAULT_TEXT, message } from '../messages.ts';
import { labelText } from '../util/text.ts';

export const NULL: ScalarValue = { t: 'null' };

/**
 * `toScalar` has no block, so option scalars leave `blockId` unbound ('') for the caller to fill in;
 * `bindScalar` / `answerScalar` in index.ts do that.
 */
export const UNBOUND_BLOCK_ID = '' as BlockId;

/** A safe integer as a number scalar (integers are always valid decimal strings). */
export const countScalar = (n: number): ScalarValue => ({ t: 'number', v: String(n) as DecimalString });

export const optionScalar = (v: OptionId): ScalarValue => ({ t: 'option', blockId: UNBOUND_BLOCK_ID, v });
export const optionList = (ids: readonly OptionId[]): ScalarValue => ({ t: 'list', of: 'option', items: ids.map(optionScalar) });

/** A palette entry with id `<type>` or `<type>.<variant>`. */
export function entry<T extends BlockType>(
  type: T,
  variant: string | null,
  category: PaletteEntry<T>['category'],
  labelKey: string,
  icon: string,
  keywords: string[],
  configOverrides: Partial<BlockConfigMap[T]> = {},
): PaletteEntry<T> {
  return { id: variant === null ? type : `${type}.${variant}`, category, labelKey, icon, keywords, configOverrides };
}

export const defaultOptions = (locale: Locale, count = 3): ChoiceOption[] =>
  Array.from({ length: count }, (_, i) => ({ id: `option_${i + 1}` as OptionId, label: message(locale, DEFAULT_TEXT['defaults.option'], { n: i + 1 }) }));

export const optionTexts = (blockId: string, options: readonly ChoiceOption[]): TextKey[] => options.map((o) => `option:${blockId}/${o.id}` as const);

export function otherTexts(blockId: string, other: OtherOption | undefined): TextKey[] {
  if (!other?.enabled) return [];
  const keys: TextKey[] = [];
  if (other.label?.trim()) keys.push(`block:${blockId}:otherLabel`);
  if (other.placeholder?.trim()) keys.push(`block:${blockId}:otherPlaceholder`);
  return keys;
}

export const optionLabel = (options: readonly ChoiceOption[], id: OptionId): string => {
  const option = options.find((o) => o.id === id);
  return option ? labelText(option.label) : id;
};

export const hasOption = (options: readonly ChoiceOption[], id: OptionId): boolean => options.some((o) => o.id === id);

/** Every id is a known option and none repeats. */
export function checkOptionIds(ids: readonly OptionId[], options: readonly ChoiceOption[], prefix: Array<string | number>, report: Report): void {
  const seen = new Set<OptionId>();
  ids.forEach((id, i) => {
    if (!hasOption(options, id)) report('not_in_options', [...prefix, i]);
    else if (seen.has(id)) report('invalid_format', [...prefix, i]);
    seen.add(id);
  });
}

/** Option images are content images (RSP-06): alt text unless decorative. */
export function optionAltLint(blockId: string, options: readonly ChoiceOption[]): PublishIssue[] {
  return options.flatMap((o, i) =>
    o.image && o.image.decorative !== true && !o.image.alt?.trim()
      ? [issue('missing_alt_text', jsonPointer('blocks', blockId, 'config', 'options', i, 'image'), 'option images need alt text unless marked decorative')]
      : []);
}

export function lengthCheck(length: number, min: number | undefined, max: number | undefined, report: Report, path: Array<string | number> = []): void {
  if (min !== undefined && length < min) report('too_short', path);
  if (max !== undefined && length > max) report('too_long', path);
}

export const isRootPath = (path: string | undefined): boolean => path === undefined || path === '';
