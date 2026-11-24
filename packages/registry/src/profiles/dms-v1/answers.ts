import type { AnswerValueMap, BlockConfigMap, DecimalString, EmailAddress, FieldBlock, IsoDate, OptionId } from '@form/schema';
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
