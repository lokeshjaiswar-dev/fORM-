import { REGISTRY } from '@form/registry';
import { htmlToInline, htmlToPlain, migrateV1ToV2, parseV1, type CountryCode, type IsoInstant, type V1MigrationResult } from '@form/schema';
import { patternProblem } from '@form/validation';
import { BUILDER_LOCALE, BUILDER_TIME_ZONE } from '@/i18n';
import { APP_IDS, type IdSource } from '@/lib/definition';

/*
 * A v1 form (a draft an older builder saved, or a v1 JSON export) becomes a v2 definition exactly once, through the
 * lenient v1 reader and `migrateV1ToV2` (schema §4.1, §4.2). The caller stores the result as a v2 draft.
 */

type V1Form = Extract<ReturnType<typeof parseV1>, { success: true }>['data'];

export interface V1Read {
  form: V1Form;
  repairs: Array<{ path: string; reason: string }>;
}

/** The lenient v1 reader: the form and every repair it made, or why the input is not a v1 form. */
export function readV1(input: unknown): { ok: true; read: V1Read } | { ok: false; error: string } {
  const parsed = parseV1(input);
  return parsed.success ? { ok: true, read: { form: parsed.data, repairs: parsed.repairs } } : { ok: false, error: parsed.error };
}

/** `migrateV1ToV2` with the builder's context, under the form id `id`. */
export function migrateDraft(form: V1Form, id: string, now: IsoInstant, ids: IdSource = APP_IDS): V1MigrationResult {
  return migrateV1ToV2({ ...form, id }, {
    idFactory: ids.newId,
    now,
    orgDefaults: { locale: BUILDER_LOCALE, timeZone: BUILDER_TIME_ZONE, country: 'IN' as CountryCode },
    htmlToInline,
    htmlToPlain,
    isSafePattern: (source) => patternProblem({ source }) === null,
    registry: REGISTRY,
  });
}
