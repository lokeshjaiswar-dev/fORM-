import type { AnswerValueMap, BlockConfigMap, DecimalString, EmailAddress, FieldBlock, IsoDate, OptionId } from '@form/schema';
import type { CountryCode } from '@form/schema';
import { CALLING_CODE_REGIONS, callingCodeOf, nationalNumberOf } from '../../util/calling-codes.ts';
import { labelText } from '../../util/text.ts';

type Answer = AnswerValueMap[FieldBlock['type']];

const daysIn = (y: number, m: number): number => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

/** `DD-MM-YYYY` (what DMS writes) or `YYYY-MM-DD` (what it also accepts) as an ISO date; `undefined` for anything else or a day that does not exist. */
export function parseDmsDate(raw: string): IsoDate | undefined {
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const [y, m, d] = dmy ? [dmy[3], dmy[2], dmy[1]] : ymd ? [ymd[1], ymd[2], ymd[3]] : [];
  if (y === undefined || m === undefined || d === undefined) return undefined;
  const year = Number(y), month = Number(m), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  return `${y}-${m}-${d}` as IsoDate;
}

/*
 * Phone numbers. DMS keeps a digits-only string (dms-api checks is_numeric; classic uses 10 national digits):
 *   India         -> the 10 national digits ("9876543210")
 *   other country -> calling code + national digits, no '+' ("12025550123")
 * Reading a stored string: 10 digits or fewer is an Indian number; longer is matched to its longest calling code.
 */
export const DMS_PHONE_INDIA_DIGITS = 10;
export const DMS_PHONE_MAX_DIGITS = 15;

/** Calling code -> the region the picker should show (India for 91, the US for 1, else the first region of the code). */
const REGION_OF_CODE: ReadonlyMap<string, CountryCode> = (() => {
  const m = new Map<string, CountryCode>();
  for (const region of CALLING_CODE_REGIONS) {
    const code = callingCodeOf(region)!;
    if (!m.has(code)) m.set(code, region);
  }
  m.set('91', 'IN' as CountryCode);
  m.set('1', 'US' as CountryCode);
  return m;
})();

/** A DMS phone string as the phone block's answer; `undefined` when it has no digits, is over 15 digits or its calling code is unknown. */
export function parseDmsPhone(raw: string): { e164: string; country: CountryCode } | undefined {
  const digits = raw.replace(/\D/g, '');
  if (digits === '' || digits.length > DMS_PHONE_MAX_DIGITS) return undefined;
  if (digits.length <= DMS_PHONE_INDIA_DIGITS) return { e164: `+91${digits}`, country: 'IN' as CountryCode };
  for (const len of [3, 2, 1]) {
    const country = REGION_OF_CODE.get(digits.slice(0, len));
    if (country !== undefined) return { e164: `+${digits}`, country };
  }
  return undefined;
}

/** A phone answer as the DMS digits string (`""` when blank). */
export function phoneToDms(answer: { e164: string; country: CountryCode }): string {
  const digits = answer.e164.replace(/\D/g, '');
  if (digits === '') return '';
  return answer.country === 'IN' ? nationalNumberOf(`+${digits}`, 'IN' as CountryCode).replace(/\D/g, '') : digits;
}

/** DMS limits on a phone answer: India is exactly 10 national digits; elsewhere 4 to 15 digits in all (E.164). `null` when fine. */
export function dmsPhoneProblem(answer: { e164: string; country: CountryCode }): string | null {
  const digits = answer.e164.replace(/\D/g, '');
  if (digits === '') return null;
  if (answer.country === 'IN') return /^\d{10}$/.test(phoneToDms(answer)) ? null : 'An Indian phone number has 10 digits.';
  return digits.length >= 4 && digits.length <= DMS_PHONE_MAX_DIGITS ? null : 'A phone number has 4 to 15 digits including the country code.';
}

const dmsDate = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const optionsOf = (block: FieldBlock) => (block.config as BlockConfigMap['single_choice']).options;
const codeOf = (o: { code?: string | undefined; label: Parameters<typeof labelText>[0] }): string => o.code ?? labelText(o.label);

/** A DMS string (`DD-MM-YYYY` date, digits, option value...) as the block's answer; `undefined` when empty or not representable. */
export function dmsToAnswer(block: FieldBlock, raw: string): Answer | undefined {
  if (raw === '') return undefined;
  switch (block.type) {
    case 'short_text':
    case 'long_text':
      return raw;
    case 'email':
      return { address: raw as EmailAddress };
    case 'phone':
      return parseDmsPhone(raw);
    case 'number':
      return /^-?(0|[1-9]\d*)$/.test(raw) && raw !== '-0' ? (raw as DecimalString) : undefined;
    case 'date':
      return parseDmsDate(raw);
    case 'single_choice': {
      const options = optionsOf(block);
      const match = options.find((o) => codeOf(o) === raw) ?? options.find((o) => labelText(o.label) === raw);
      return match ? { optionId: match.id as OptionId } : undefined;
    }
    default:
      return undefined;
  }
}

/** The block's answer as the DMS string the upload journey and the record API carry (`""` when there is none). */
export function answerToDms(block: FieldBlock, answer: Answer | undefined): string {
  if (answer === undefined || answer === null) return '';
  switch (block.type) {
    case 'short_text':
    case 'long_text':
    case 'number':
      return typeof answer === 'string' ? answer : '';
    case 'email':
      return typeof answer === 'object' && 'address' in answer ? answer.address : '';
    case 'phone':
      return typeof answer === 'object' && 'e164' in answer ? phoneToDms(answer as { e164: string; country: CountryCode }) : '';
    case 'date':
      return typeof answer === 'string' ? dmsDate(answer) : '';
    case 'single_choice': {
      if (typeof answer !== 'object' || !('optionId' in answer) || answer.optionId === null) return '';
      const match = optionsOf(block).find((o) => o.id === answer.optionId);
      return match ? codeOf(match) : '';
    }
    default:
      return '';
  }
}
