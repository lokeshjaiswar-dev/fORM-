import { parseV1 } from '../v1.ts';
import type * as V1 from '../v1.ts';
import { SCHEMA_VERSION, type FormDefinition } from '../v2/definition.ts';
import type { Migrate } from '../v2/entry-points.ts';
import type { AnyFormDocument, MigrationContext, MigrationNote, MigrationStep } from '../v2/migration.ts';
import { FormDefinitionSchema } from '../v2/zod/definition.ts';
import { migrateV1ToV2 } from './v1-to-v2.ts';

export { NOTE_MEANINGS } from './notes.ts';
export { V1_VALUE_TYPES, hexColor, migrateV1ToV2, slugOf, toDecimal } from './v1-to-v2.ts';

const LEFT_OUT = 'this migrate() step returns the definition only; a caller that stores the form uses migrateV1ToV2 (schema §4.1)';

/**
 * v1 → v2. The step keeps the definition and notes; the password, asset imports and ops (closed state, retention) are
 * returned only by `migrateV1ToV2`, so the notes about them say they were left out here.
 */
export const V1_TO_V2: MigrationStep<V1.FormSchema, FormDefinition> = {
  from: 1,
  to: 2,
  migrate(doc, ctx) {
    const { definition, notes, assetImports } = migrateV1ToV2(doc, ctx);
    const queued = new Set(assetImports.map((a) => `/settings/${a.target}Url`));
    return {
      doc: definition,
      notes: notes.map((n) => (n.code === 'password_extracted' || (n.code === 'external_asset_queued' && queued.has(n.path))
        ? { ...n, detail: `${n.detail}; ${LEFT_OUT}` } : n)),
    };
  },
};

/** Form document steps in order (schema §4.1). A document with no `schemaVersion` is v1. */
export const FORM_MIGRATIONS = [V1_TO_V2] as const;

const versionOf = (doc: AnyFormDocument): number => ('schemaVersion' in doc ? doc.schemaVersion : 1);

/**
 * `migrate(doc, ctx)` (schema §19): runs the pure steps from the document's version to `SCHEMA_VERSION`. A current
 * definition is returned as it is, with no notes, so migrating twice changes nothing. A newer version throws.
 */
export const migrate: Migrate = (doc, ctx) => {
  const version = versionOf(doc);
  if (version > SCHEMA_VERSION) throw new Error(`schemaVersion ${version} is newer than this build (${SCHEMA_VERSION})`);
  if (version === SCHEMA_VERSION) return { definition: doc as FormDefinition, notes: [] };
  const notes: MigrationNote[] = [];
  let current: unknown = doc;
  for (const step of FORM_MIGRATIONS) {
    if (step.from < version) continue;
    const out = step.migrate(current as V1.FormSchema, ctx);
    notes.push(...out.notes);
    current = out.doc;
  }
  return { definition: current as FormDefinition, notes };
};

/**
 * Reads a stored, exported or authored form document of any version and migrates it: a document without
 * `schemaVersion` goes through the lenient `parseV1`, a current one through its twin. Throws when neither reader
 * accepts it. Pack import and `templates:build` bind this as `TemplateMigrationContext.migrateDocument`.
 */
export function migrateUnknown(input: unknown, ctx: MigrationContext): { definition: FormDefinition; notes: MigrationNote[] } {
  if (typeof input === 'object' && input !== null && 'schemaVersion' in input) {
    const version = (input as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version > SCHEMA_VERSION) throw new Error(`schemaVersion ${version} is newer than this build (${SCHEMA_VERSION})`);
    const parsed = FormDefinitionSchema.safeParse(input);
    if (!parsed.success) throw new Error(`invalid form definition: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`);
    return migrate(parsed.data, ctx);
  }
  const v1 = parseV1(input);
  if (!v1.success) throw new Error(`invalid v1 form: ${v1.error}`);
  return migrate(v1.data, ctx);
}
