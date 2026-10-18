import { evaluate } from '@form/logic';
import type * as S from '@form/schema';
import { normalizeAnswers, validateAnswers, type RawAnswers, type ValidateOptions } from '../src/index.ts';
import { EN_IN, META, bid, id, oid, pid, versionOf } from './build.ts';

/* Evaluate-then-validate, the way the renderer (Next / Submit) and the submission pipeline call the package. */

export const TODAY = id<S.IsoDate>('2026-10-18');

export interface Run {
  version: S.FormVersion;
  state: S.EvalState;
  errors: S.FieldError[];
}

export function run(def: S.FormDefinition, raw: RawAnswers, scope: ValidateOptions['scope'] = 'submit', opts: Partial<ValidateOptions> = {}): Run {
  const version = versionOf(def);
  const state = evaluate(version, normalizeAnswers(raw), META, 'client');
  const errors = validateAnswers(version, state, raw, { scope, locale: EN_IN, today: TODAY, ...opts });
  return { version, state, errors };
}

export const onPage = (pageId: string): ValidateOptions['scope'] => ({ page: pid(pageId) });

/** `blockId code` (or `blockId.path code`) per error, for compact assertions. */
export const codes = (errors: readonly S.FieldError[]): string[] =>
  errors.map((e) => `${e.blockId ?? '-'}${e.path === undefined ? '' : `.${e.path}`} ${e.code}`);

/* Answers beyond the ones build.ts has. */
export const ans = {
  ranking: (...o: string[]): S.AnswerValue => ({ type: 'ranking', value: o.map(oid) }),
  scale: (v: number): S.AnswerValue => ({ type: 'linear_scale', value: v }),
  url: (v: string): S.AnswerValue => ({ type: 'url', value: v }),
  phone: (e164: string, country = 'IN'): S.AnswerValue => ({ type: 'phone', value: { e164, country: id<S.CountryCode>(country) } }),
  timeRange: (start: string, end?: string): S.AnswerValue => ({
    type: 'time',
    value: end === undefined ? { start: id<S.IsoTime>(start) } : { start: id<S.IsoTime>(start), end: id<S.IsoTime>(end) },
  }),
  multiOther: (other: string, ...o: string[]): S.AnswerValue => ({ type: 'multi_choice', value: { optionIds: o.map(oid), other } }),
  files: (...files: Array<Partial<S.FileRef>>): S.AnswerValue => ({
    type: 'file_upload',
    value: files.map((f, i) => ({
      fileId: id<S.FileId>(`file_${i + 1}`),
      name: 'cv.pdf',
      sizeBytes: 1000,
      mime: 'application/pdf',
      sha256: id<S.Sha256Hex>('a'.repeat(64)),
      ...f,
    })),
  }),
  signature: (method: 'drawn' | 'typed', typedName?: string): S.AnswerValue => ({
    type: 'signature',
    value: {
      method,
      file: { fileId: id<S.FileId>('sig_1'), name: 'signature.png', sizeBytes: 2048, mime: 'image/png', sha256: id<S.Sha256Hex>('b'.repeat(64)) },
      ...(typedName === undefined ? {} : { typedName }),
    },
  }),
  raw: (type: string, value: unknown): S.AnswerValue => ({ type, value }) as unknown as S.AnswerValue,
};

export const blocks = (...ids: string[]) => ids.map(bid);
