import type { _ExactKeys } from './_internal.ts';
import type { ValueFieldType } from './catalogue.ts';
import type { AddressPart, NamePart } from './config.ts';
import type { ScalarValue } from './expr.ts';
import type { BlockId, ConsentItemId, CountryCode, CurrencyCode, DecimalString, EmailAddress, FileId, GroupRowId, IsoDate, IsoInstant, IsoLocalDateTime, IsoTime, Locale, MatrixColumnId, MatrixRowId, MinorUnits, OptionId, ProductId, ProductOptionId, Sha256Hex, TimeZone } from './ids.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §15  ANSWERS — tagged by block type; shape = f(type) (I2); absent = unanswered (I9)
 * ═════════════════════════════════════════════════════════════════════════ */

export interface FileRef { fileId: FileId; name: string; sizeBytes: number; mime: string /* sniffed */; sha256: Sha256Hex; scan?: 'pending' | 'clean' | 'infected' | 'skipped' }

export type MatrixValue =
  | { mode: 'single'; rows: Partial<Record<MatrixRowId, MatrixColumnId>> }
  | { mode: 'multi'; rows: Partial<Record<MatrixRowId, MatrixColumnId[]>> }
  | { mode: 'grid'; rows: Partial<Record<MatrixRowId, Partial<Record<MatrixColumnId, string | DecimalString | OptionId | boolean>>>> };

export interface SignatureValue {
  method: 'drawn' | 'typed';
  file: FileRef;                   // PNG via renderer `uploader` (S10: never a data URL)
  typedName?: string;
  /** WFL-07; server-completed. */
  audit?: { signedAt: IsoInstant; evidenceHash?: Sha256Hex /* hash of (ip, ua, time, versionId); not a bare IP hash */; versionContentHash: Sha256Hex; statementHash?: Sha256Hex; answersHash: Sha256Hex };
}

export interface PaymentSelection {
  items?: Array<{ productId: ProductId; quantity: number; options?: Partial<Record<ProductOptionId, OptionId>> }>;
  customAmount?: MinorUnits;
  couponCode?: string;
  currency: CurrencyCode;
  /** Advisory; server recomputes; mismatch → 422 amount_changed. */
  clientTotal?: MinorUnits;
}

export interface AnswerValueMap {
  short_text: string;
  long_text: string;
  full_name: Partial<Record<NamePart, string>>;
  email: { address: EmailAddress; otpProof?: string };
  phone: { e164: string; country: CountryCode };
  address: Partial<Record<AddressPart, string>> & { stateCode?: string };
  number: DecimalString;
  url: string;
  single_choice: { optionId: OptionId | null /* null + other = "Other" */; other?: string };
  multi_choice: { optionIds: OptionId[]; other?: string };
  date: IsoDate;
  datetime: { local: IsoLocalDateTime; timeZone: TimeZone; instant: IsoInstant };
  time: { start: IsoTime; end?: IsoTime };
  rating: number;
  linear_scale: number;
  nps: number;
  ranking: OptionId[];
  matrix: MatrixValue;
  repeating_group: { rows: Array<{ rowId: GroupRowId; values: Partial<Record<BlockId, StoredAnswer>> }> };   // children may be encrypted
  file_upload: FileRef[];
  signature: SignatureValue;
  hidden: string;
  consent: { items: Partial<Record<ConsentItemId, boolean>>; noticeLocale: Locale; noticeVersion: number; scrolledToEnd?: boolean; guardian?: { email: EmailAddress; verifiedAt?: IsoInstant } };
  payment: PaymentSelection;
  appointment: { start: IsoInstant; end: IsoInstant; respondentTimeZone: TimeZone; holdToken?: string };
  calculation: ScalarValue;
  context: string;
  unique_id: string;
}
export const _answersComplete: _ExactKeys<AnswerValueMap, ValueFieldType> = true;

export type AnswerValue = { [T in ValueFieldType]: { type: T; value: AnswerValueMap[T] } }[ValueFieldType];
export type AnswerOf<T extends ValueFieldType> = Extract<AnswerValue, { type: T }>;
export type Answers = Partial<Record<BlockId, AnswerValue>>;

/** CMP-07. The type tag stays clear so readers know the shape after decrypt. */
export interface EncryptedAnswer {
  type: ValueFieldType;
  enc: { alg: 'A256GCM'; kid: string /* org DEK version; deleting a DEK is not erasure while backups hold it */; iv: string; ct: string /* JCS(value) */; aad: `${string}:${string}` /* submissionId:blockId */ };
  bidx?: { kid: string; values: string[] };   // CMP-08
}
export type StoredAnswer = AnswerValue | EncryptedAnswer;
/** Tainted computed values (I13) are stored encrypted. */
export interface EncryptedScalar { enc: EncryptedAnswer['enc'] }
