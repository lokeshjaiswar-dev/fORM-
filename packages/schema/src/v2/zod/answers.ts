import { z } from 'zod';
import type { StoredAnswer } from '../answers.ts';
import { depthGuard, guarded, guardedMap, keyed, options, tagged } from './_util.ts';
import { ValueFieldTypeSchema } from './catalogue.ts';
import { NamePartSchema } from './config.ts';
import { ScalarValueSchema } from './logic.ts';
import {
  BlockIdSchema, ConsentItemIdSchema, CountryCodeSchema, CurrencyCodeSchema, DecimalStringSchema, EmailAddressSchema, FileIdSchema,
  GroupRowIdSchema, IsoDateSchema, IsoInstantSchema, IsoLocalDateTimeSchema, IsoTimeSchema, LocaleSchema, MatrixColumnIdSchema,
  MatrixRowIdSchema, MinorUnitsSchema, OptionIdSchema, ProductIdSchema, ProductOptionIdSchema, Sha256HexSchema, TimeZoneSchema,
} from './primitives.ts';

const StoredAnswerNode: z.ZodType<StoredAnswer> = z.lazy(() => StoredAnswerShape);

/* I9: unanswered is an absent key, so a present answer never holds '', [] or no parts at all. */
const text = z.string().min(1).max(50_000);
const part = (max: number) => z.string().min(1).max(max);
const someValue = (v: object) => Object.values(v).some((x) => x !== undefined);
const answered = <S extends z.ZodType<object>>(schema: S, what: string) => schema.refine(someValue, `${what} needs at least one answer`);

export const FileRefSchema = z.strictObject({
  fileId: FileIdSchema,
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  mime: z.string().min(1).max(255),
  sha256: Sha256HexSchema,
  scan: z.enum(['pending', 'clean', 'infected', 'skipped']).exactOptional(),
});

export const MatrixValueSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('single'), rows: keyed(answered(z.partialRecord(MatrixRowIdSchema, MatrixColumnIdSchema), 'a matrix')) }),
  z.strictObject({ mode: z.literal('multi'), rows: keyed(answered(z.partialRecord(MatrixRowIdSchema, z.array(MatrixColumnIdSchema).min(1)), 'a matrix')) }),
  z.strictObject({
    mode: z.literal('grid'),
    rows: keyed(answered(z.partialRecord(MatrixRowIdSchema, keyed(answered(z.partialRecord(MatrixColumnIdSchema, z.union([part(10_000), DecimalStringSchema, OptionIdSchema, z.boolean()])), 'a matrix row'))), 'a matrix')),
  }),
]);

export const SignatureValueSchema = z.strictObject({
  method: z.enum(['drawn', 'typed']),
  file: FileRefSchema,
  typedName: z.string().max(200).exactOptional(),
  audit: z.strictObject({
    signedAt: IsoInstantSchema,
    evidenceHash: Sha256HexSchema.exactOptional(),
    versionContentHash: Sha256HexSchema,
    statementHash: Sha256HexSchema.exactOptional(),
    answersHash: Sha256HexSchema,
  }).exactOptional(),
});

export const PaymentSelectionSchema = z.strictObject({
  items: z.array(z.strictObject({
    productId: ProductIdSchema,
    quantity: z.number().int().min(1),
    options: keyed(z.partialRecord(ProductOptionIdSchema, OptionIdSchema)).exactOptional(),
  })).min(1).exactOptional(),
  customAmount: MinorUnitsSchema.exactOptional(),
  couponCode: z.string().max(64).exactOptional(),
  currency: CurrencyCodeSchema,
  clientTotal: MinorUnitsSchema.exactOptional(),
}).refine((v) => v.items !== undefined || v.customAmount !== undefined, 'a payment needs items or a custom amount');

const scale = z.number().int().min(0).max(10);
const ANSWER_VALUE_SHAPE = {
  short_text: text,
  long_text: text,
  full_name: keyed(z.partialRecord(NamePartSchema, part(200)).refine(someValue, 'a name needs at least one part')),
  email: z.strictObject({ address: EmailAddressSchema, otpProof: z.string().exactOptional() }),
  phone: z.strictObject({ e164: z.string().regex(/^\+[1-9]\d{1,14}$/), country: CountryCodeSchema }),
  address: z.strictObject({
    line1: part(200).exactOptional(),
    line2: part(200).exactOptional(),
    city: part(200).exactOptional(),
    state: part(200).exactOptional(),
    postalCode: part(32).exactOptional(),
    country: part(200).exactOptional(),
    stateCode: part(16).exactOptional(),
  }).refine(someValue, 'an address needs at least one part'),
  number: DecimalStringSchema,
  url: text.max(2048),
  single_choice: z.strictObject({ optionId: OptionIdSchema.nullable(), other: part(10_000).exactOptional() })
    .refine((v) => v.optionId !== null || v.other !== undefined, 'a null option needs an other text'),
  multi_choice: z.strictObject({ optionIds: z.array(OptionIdSchema), other: part(10_000).exactOptional() })
    .refine((v) => v.optionIds.length > 0 || v.other !== undefined, 'pick at least one option or give an other text'),
  date: IsoDateSchema,
  datetime: z.strictObject({ local: IsoLocalDateTimeSchema, timeZone: TimeZoneSchema, instant: IsoInstantSchema }),
  time: z.strictObject({ start: IsoTimeSchema, end: IsoTimeSchema.exactOptional() }),
  rating: scale,
  linear_scale: scale,
  nps: scale,
  ranking: z.array(OptionIdSchema).min(1),
  matrix: MatrixValueSchema,
  repeating_group: z.strictObject({
    rows: z.array(z.strictObject({ rowId: GroupRowIdSchema, values: keyed(z.partialRecord(BlockIdSchema, StoredAnswerNode)) })).min(1).max(200),
  }),
  file_upload: z.array(FileRefSchema).min(1).max(20),
  signature: SignatureValueSchema,
  hidden: text,
  consent: z.strictObject({
    items: keyed(answered(z.partialRecord(ConsentItemIdSchema, z.boolean()), 'a consent')),
    noticeLocale: LocaleSchema,
    noticeVersion: z.number().int().min(0),
    scrolledToEnd: z.boolean().exactOptional(),
    guardian: z.strictObject({ email: EmailAddressSchema, verifiedAt: IsoInstantSchema.exactOptional() }).exactOptional(),
  }),
  payment: PaymentSelectionSchema,
  appointment: z.strictObject({ start: IsoInstantSchema, end: IsoInstantSchema, respondentTimeZone: TimeZoneSchema, holdToken: z.string().exactOptional() }),
  calculation: ScalarValueSchema,
  context: part(10_000),
  unique_id: z.string().min(1).max(128),
};

export const AnswerValueMapSchema = guarded(depthGuard, z.strictObject(ANSWER_VALUE_SHAPE));
const ANSWER_VALUE_NODES = tagged(ANSWER_VALUE_SHAPE);
/** Twin of AnswerOf<T> for every value field type. */
export const ANSWER_VALUE_SCHEMAS = guardedMap(depthGuard, ANSWER_VALUE_NODES);
const AnswerValueShape = z.discriminatedUnion('type', options(ANSWER_VALUE_NODES));
export const AnswerValueSchema = guarded(depthGuard, AnswerValueShape);
export const AnswersSchema = keyed(z.partialRecord(BlockIdSchema, AnswerValueSchema));

const encryption = z.strictObject({
  alg: z.literal('A256GCM'),
  kid: z.string().min(1).max(128),
  iv: z.string().min(1).max(64),
  ct: z.string().min(1),
  aad: z.templateLiteral([z.string(), ':', z.string()]),
});
export const EncryptedAnswerSchema = z.strictObject({
  type: ValueFieldTypeSchema,
  enc: encryption,
  bidx: z.strictObject({ kid: z.string().min(1).max(128), values: z.array(z.string()) }).exactOptional(),
});
const StoredAnswerShape = z.union([AnswerValueShape, EncryptedAnswerSchema]);
export const StoredAnswerSchema = guarded(depthGuard, StoredAnswerShape);
export const EncryptedScalarSchema = z.strictObject({ enc: encryption });
