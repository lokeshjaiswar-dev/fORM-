import { SCHEMA_VERSION } from '../v2/definition.ts';
import type { MigrationNote } from '../v2/migration.ts';
import { TEMPLATE_KINDS } from '../v2/templates.ts';
import type { RawTemplatePayload, TemplateKind, TemplateMigrationContext, TemplateMigrationIssue, TemplateMigrationResult, TemplatePayloadMigrationStep } from '../v2/templates.ts';
import { TemplateVersionPayloadSchema } from '../v2/zod/templates.ts';
import { jsonPointer } from '../validate/structure.ts';

/** Payload steps (v_n → v_n+1). Empty while every payload kind is still at its first schema version. */
export const TEMPLATE_PAYLOAD_MIGRATIONS: readonly TemplatePayloadMigrationStep[] = [];

type Rec = Record<string, unknown>;
type Issues = TemplateMigrationIssue[];

const KINDS: ReadonlySet<string> = new Set(TEMPLATE_KINDS);
const REF_LISTS = ['endings', 'emails', 'pdf'] as const;
const REF_ONES = ['theme', 'workflow'] as const;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKind = (v: unknown): v is TemplateKind => typeof v === 'string' && KINDS.has(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const under = (base: string, notes: MigrationNote[]): MigrationNote[] => notes.map((n) => ({ ...n, path: `${base}${n.path}` }));

function runSteps(payload: RawTemplatePayload, path: string, steps: readonly TemplatePayloadMigrationStep[], issues: Issues, notes: MigrationNote[]): RawTemplatePayload | undefined {
  let current = payload;
  while (current.schemaVersion < SCHEMA_VERSION) {
    const { kind, schemaVersion } = current;
    const step = steps.find((s) => s.from === schemaVersion && s.to === schemaVersion + 1 && s.kinds.includes(kind));
    if (!step) {
      issues.push({ code: 'migration_step_missing', path: `${path}/schemaVersion`, message: `no ${kind} payload step from schemaVersion ${schemaVersion}` });
      return undefined;
    }
    try {
      const out = step.migrate(current);
      notes.push(...under(path, out.notes));
      current = { ...out.payload, kind, schemaVersion: step.to };
    } catch (e) {
      issues.push({ code: 'migration_failed', path, message: `${kind} payload step ${step.from}→${step.to}: ${message(e)}` });
      return undefined;
    }
  }
  return current;
}

function migrateDocument(document: unknown, path: string, ctx: TemplateMigrationContext, issues: Issues, notes: MigrationNote[]): unknown {
  if (isRec(document) && document['schemaVersion'] === SCHEMA_VERSION) return document;
  if (!ctx.migrateDocument) {
    issues.push({ code: 'document_migration_unavailable', path, message: 'the document is not at the current schemaVersion and no form migrate() was given' });
    return document;
  }
  try {
    const out = ctx.migrateDocument(document);
    notes.push(...under(path, out.notes));
    return out.definition;
  } catch (e) {
    issues.push({ code: 'migration_failed', path, message: `form document: ${message(e)}` });
    return document;
  }
}

/** Inline refs are payloads of their own; a `TemplateRef` (no `kind`) is left as it is. */
function migrateRefs(refs: Rec, path: string, ctx: TemplateMigrationContext, issues: Issues, notes: MigrationNote[]): Rec {
  const out: Rec = { ...refs };
  const one = (value: unknown, at: string) => (isRec(value) && 'kind' in value ? upgrade(value, at, ctx, issues, notes) : value);
  for (const key of REF_ONES) if (key in refs) out[key] = one(refs[key], `${path}/${key}`);
  for (const key of REF_LISTS) {
    const list = refs[key];
    if (Array.isArray(list)) out[key] = list.map((item: unknown, i) => one(item, `${path}/${key}/${i}`));
  }
  return out;
}

function upgrade(input: unknown, path: string, ctx: TemplateMigrationContext, issues: Issues, notes: MigrationNote[]): unknown {
  if (!isRec(input)) {
    issues.push({ code: 'payload_not_object', path, message: 'a template payload is a JSON object' });
    return input;
  }
  const { kind, schemaVersion } = input;
  if (!isKind(kind)) {
    issues.push({ code: 'unknown_kind', path: `${path}/kind`, message: `unknown template kind ${JSON.stringify(kind)}` });
    return input;
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    issues.push({ code: 'schema_version_invalid', path: `${path}/schemaVersion`, message: 'schemaVersion must be a positive integer' });
    return input;
  }
  if (schemaVersion > SCHEMA_VERSION) {
    issues.push({ code: 'schema_version_newer', path: `${path}/schemaVersion`, message: `schemaVersion ${schemaVersion} is newer than this build (${SCHEMA_VERSION})` });
    return input;
  }
  const current = runSteps({ ...input, kind, schemaVersion }, path, ctx.steps ?? TEMPLATE_PAYLOAD_MIGRATIONS, issues, notes);
  if (!current || current.kind !== 'form') return current ?? input;
  const out: Rec = { ...current, document: migrateDocument(current['document'], `${path}/document`, ctx, issues, notes) };
  const refs = current['refs'];
  if (isRec(refs)) out['refs'] = migrateRefs(refs, `${path}/refs`, ctx, issues, notes);
  return out;
}

/**
 * Brings a stored, imported or authored template payload to the current schema, then parses it with
 * its twin. Never mutates `input`. Pack import and `templates:build` run this before full validation.
 */
export function migrateTemplatePayload(input: unknown, ctx: TemplateMigrationContext = {}): TemplateMigrationResult {
  const issues: Issues = [];
  const notes: MigrationNote[] = [];
  const upgraded = upgrade(input, '', ctx, issues, notes);
  if (issues.length > 0) return { ok: false, issues };
  const parsed = TemplateVersionPayloadSchema.safeParse(upgraded);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ code: 'invalid_payload', path: jsonPointer(...i.path.map((p) => (typeof p === 'number' ? p : String(p)))), message: i.message })),
    };
  }
  return { ok: true, payload: parsed.data, notes };
}
