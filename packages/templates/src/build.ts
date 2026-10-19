import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormpackAttestationSchema, FormpackManifestSchema, FormpackTemplateFileSchema, SCHEMA_VERSION, jsonPointer, migrateTemplatePayload } from '@form/schema';
import type {
  DataClassification, FeatureId, FieldBlock, FormDefinition, FormTemplatePayload, FormpackAttestation, FormpackManifest, FormpackTemplateFile,
  InstantiateContext, IsoInstant, StoredBlock, TemplateVersionPayload,
} from '@form/schema';
import { instantiate, variableNames } from '@form/templates-core';
import { z } from 'zod';
import {
  ATTESTATIONS_PATH, CATEGORIES_PATH, PackCategorySchema, jsonBytes, sha256Hex, writeFormpack, type FormpackTemplateEntry, type PackCategory, type PackSigner,
} from './formpack.ts';
import { packTemplateVersion, type PackOf } from './version.ts';

/* `templates:build` (templates spec §8.2): validate the authored templates against the registry and logic, then write a signed pack. */

/** `pack.json` next to a pack's template sources. */
export const PackDescriptorSchema = z.strictObject({
  publisher: z.string().min(1).max(100),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
  minAppVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
  templates: z.array(z.strictObject({ slug: z.string().min(1), version: z.number().int().min(1), source: z.string().regex(/^[a-z0-9][a-z0-9-]*\.json$/) })).min(1),
});
export type PackDescriptor = z.infer<typeof PackDescriptorSchema>;

export interface PackSource {
  pack: Omit<PackDescriptor, 'templates'>;
  templates: Array<{ slug: string; version: number; file: unknown }>;
  categories: unknown;
  attestations?: unknown;
}

/** `at` names the template (`slug@version`) or the pack file the issue is in; `path` points into it. */
export interface BuildIssue { at: string; code: string; path: string; message: string }

export type BuildResult =
  | { ok: true; fileName: string; bytes: Uint8Array; manifest: FormpackManifest; warnings: BuildIssue[] }
  | { ok: false; issues: BuildIssue[]; warnings: BuildIssue[] };

const SLUG = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
const BUILT_IN_VARIABLES = ['org.', 'brand.', 'form.'];
/** Fixed inputs of the instance check: it validates the instance and keeps nothing, so no clock or random seed. */
const CHECK_NOW = '2026-01-01T00:00:00Z' as IsoInstant;
const RANK: Readonly<Record<DataClassification, number>> = { none: 0, personal: 1, sensitive: 2 };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const blocksOf = (payload: TemplateVersionPayload): StoredBlock[] => {
  if (payload.kind === 'form') return Object.values(payload.document.blocks).filter((b) => b !== undefined);
  if (payload.kind === 'snippet') return Object.values(payload.blocks).filter((b) => b !== undefined);
  return [];
};

/** The payload's declared features plus `field:<type>` for every block type it uses, sorted. */
export function requiredFeatures(payload: TemplateVersionPayload): FeatureId[] {
  const out = new Set<FeatureId>(payload.requiredFeatures);
  for (const block of blocksOf(payload)) if (block.type !== 'unsupported') out.add(`field:${block.type}`);
  return [...out].sort();
}

const fieldsOf = (def: FormDefinition): FieldBlock[] => Object.values(def.blocks).filter((b): b is FieldBlock => b !== undefined && 'compliance' in b);

/** The data inventory must describe the document: per purpose, exactly its personal or sensitive fields, their highest class and encryption. */
function inventoryIssues(payload: FormTemplatePayload): Array<Omit<BuildIssue, 'at'>> {
  const issues: Array<Omit<BuildIssue, 'at'>> = [];
  const fields = fieldsOf(payload.document);
  const { purposes } = payload.document.privacy;
  payload.dataInventory.forEach((entry, i) => {
    const path = jsonPointer('payload', 'dataInventory', i);
    const purpose = purposes.find((p) => p.name === entry.purposeName);
    if (!purpose) {
      issues.push({ code: 'inventory_mismatch', path, message: `no purpose is named ${JSON.stringify(entry.purposeName)}` });
      return;
    }
    const ofPurpose = fields.filter((b) => b.compliance.purposeIds.includes(purpose.id));
    const listed = ofPurpose.filter((b) => entry.fieldSourceIds.includes(b.id));
    const stray = entry.fieldSourceIds.filter((id) => !listed.some((b) => b.id === id));
    const missing = ofPurpose.filter((b) => b.compliance.classification !== 'none' && !entry.fieldSourceIds.includes(b.id)).map((b) => b.id);
    const highest = listed.reduce<DataClassification>((c, b) => (RANK[b.compliance.classification] > RANK[c] ? b.compliance.classification : c), 'none');
    if (stray.length) issues.push({ code: 'inventory_mismatch', path, message: `${stray.join(', ')} are not fields of '${purpose.name}'` });
    if (missing.length) issues.push({ code: 'inventory_mismatch', path, message: `'${purpose.name}' also collects ${missing.join(', ')}` });
    if (entry.classification !== highest) issues.push({ code: 'inventory_mismatch', path, message: `classification is ${entry.classification}, the fields' highest is ${highest}` });
    if (entry.encrypted !== listed.some((b) => b.compliance.encrypt)) issues.push({ code: 'inventory_mismatch', path, message: 'encrypted does not match the fields' });
  });
  for (const purpose of purposes) {
    const collects = fields.some((b) => b.compliance.classification !== 'none' && b.compliance.purposeIds.includes(purpose.id));
    if (collects && !payload.dataInventory.some((e) => e.purposeName === purpose.name)) {
      issues.push({ code: 'inventory_mismatch', path: '/payload/dataInventory', message: `'${purpose.name}' has no data inventory entry` });
    }
  }
  return issues;
}

function instanceContext(slug: string, version: number, payload: FormTemplatePayload): InstantiateContext {
  return {
    newFormId: 'template_check' as InstantiateContext['newFormId'],
    idSeed: `${slug}@${version}`,
    bindingIdSeed: `${slug}@${version}/bindings`,
    locale: payload.i18n.defaultLocale,
    extraLocales: [],
    orgProfile: null,
    brandKit: null,
    variables: {},
    include: { theme: true, emails: true, endings: true, pdf: true, workflow: true },
    now: CHECK_NOW,
  };
}

interface Checked { entry: Omit<FormpackTemplateEntry, 'path' | 'sha256'>; file: FormpackTemplateFile }

type Add = (issue: Omit<BuildIssue, 'at'>, warn?: boolean) => void;

function checkForm(pack: PackOf, entry: Checked['entry'], file: FormpackTemplateFile, payload: FormTemplatePayload, add: Add): void {
  const issues = validateDefinition(payload.document, 'publish', REGISTRY);
  for (const issue of issues) add({ code: issue.code, path: `/payload/document${issue.path}`, message: issue.message }, issue.severity === 'warning');
  const refs = payload.refs ?? {};
  const listed: Array<[string, unknown]> = [
    ['theme', refs.theme], ['workflow', refs.workflow],
    ...(['endings', 'emails', 'pdf'] as const).flatMap((k) => (refs[k] ?? []).map((r, i): [string, unknown] => [`${k}/${i}`, r])),
  ];
  for (const [at, ref] of listed) {
    if (isRec(ref) && !('kind' in ref)) add({ code: 'ref_not_inline', path: `/payload/refs/${at}`, message: 'a pack template inlines its refs; a TemplateRef cannot be resolved inside a pack' });
  }
  const declared = new Set<string>(payload.variables.map((v) => v.name));
  for (const name of variableNames(payload)) {
    if (!declared.has(name) && !BUILT_IN_VARIABLES.some((ns) => name.startsWith(ns))) {
      add({ code: 'variable_undeclared', path: '/payload/variables', message: `variable ${JSON.stringify(name)} is used but not declared` });
    }
  }
  for (const issue of inventoryIssues(payload)) add(issue);
  /* Instances must validate too: with the declared defaults, optional parts applied and refs inlined. */
  if (issues.some((i) => i.severity === 'error')) return;
  try {
    const result = instantiate(packTemplateVersion(pack, { entry, file }, CHECK_NOW), instanceContext(entry.slug, entry.version, payload));
    for (const issue of validateDefinition(result.definition, 'save', REGISTRY)) {
      if (issue.severity === 'error') add({ code: 'instance_invalid', path: `/instance${issue.path}`, message: `${issue.code}: ${issue.message}` });
    }
  } catch (e) {
    add({ code: 'instance_invalid', path: '/payload', message: e instanceof Error ? e.message : String(e) });
  }
}

function checkTemplate({ slug, version, file: raw }: PackSource['templates'][number], pack: PackOf, categories: ReadonlySet<string>, add: Add): Checked | null {
  if (!SLUG.test(slug) || slug.length > 128) add({ code: 'invalid_slug', path: '', message: `slug ${JSON.stringify(slug)} is not lowercase segments separated by '/'` });
  if (!isRec(raw)) {
    add({ code: 'invalid_file', path: '', message: 'a template file is a JSON object' });
    return null;
  }
  /* Sources are kept at the current schema: no form migrate() is bound, so an older document is an error. */
  const migrated = migrateTemplatePayload(raw['payload']);
  if (!migrated.ok) {
    for (const issue of migrated.issues) add({ code: issue.code, path: `/payload${issue.path}`, message: issue.message });
    return null;
  }
  const parsed = FormpackTemplateFileSchema.safeParse({ ...raw, payload: migrated.payload });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add({ code: 'invalid_file', path: jsonPointer(...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))), message: issue.message });
    return null;
  }
  const file = parsed.data;
  const { payload } = file;
  const locales = file.localizations.map((l) => l.locale);
  if (!locales.includes(payload.i18n.defaultLocale)) {
    add({ code: 'localization_missing', path: '/localizations', message: `no gallery text in the default locale ${payload.i18n.defaultLocale}` });
  }
  if (new Set(locales).size !== locales.length) add({ code: 'localization_duplicate', path: '/localizations', message: 'a locale has two gallery texts' });
  file.categorySlugs.forEach((c, i) => {
    if (!categories.has(c)) add({ code: 'category_unknown', path: jsonPointer('categorySlugs', i), message: `category ${JSON.stringify(c)} is not in categories.json` });
  });
  const entry = { slug, kind: payload.kind, version, requiredFeatures: requiredFeatures(payload), dependsOn: [] };
  if (payload.kind === 'form') checkForm(pack, entry, file, payload, add);
  return { entry, file };
}

function checkCategories(raw: unknown, add: (i: BuildIssue) => void): PackCategory[] {
  const parsed = z.array(PackCategorySchema).safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add({ at: CATEGORIES_PATH, code: 'invalid_file', path: jsonPointer(...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))), message: issue.message });
    return [];
  }
  const slugs = new Set<string>();
  parsed.data.forEach((c, i) => {
    if (slugs.has(c.slug)) add({ at: CATEGORIES_PATH, code: 'category_duplicate', path: jsonPointer(i, 'slug'), message: `category ${c.slug} appears twice` });
    slugs.add(c.slug);
  });
  parsed.data.forEach((c, i) => {
    if (c.parentSlug !== undefined && !slugs.has(c.parentSlug)) add({ at: CATEGORIES_PATH, code: 'category_unknown', path: jsonPointer(i, 'parentSlug'), message: `parent ${c.parentSlug} is not a category` });
  });
  return parsed.data;
}

/** Validates every template of a pack source. Errors stop the build; warnings (publish-time lints) are reported. */
export function validatePackSource(source: PackSource): { issues: BuildIssue[]; warnings: BuildIssue[]; templates: Checked[]; categories: PackCategory[]; attestations: FormpackAttestation[] } {
  const issues: BuildIssue[] = [];
  const warnings: BuildIssue[] = [];
  const categories = checkCategories(source.categories, (i) => issues.push(i));
  const pack: PackOf = { manifest: { pack: { publisher: source.pack.publisher, name: source.pack.name, version: source.pack.version } } };
  const categorySlugs = new Set(categories.map((c) => c.slug));
  const templates: Checked[] = [];
  const seen = new Set<string>();
  for (const template of source.templates) {
    const at = `${template.slug}@${template.version}`;
    if (seen.has(template.slug)) issues.push({ at, code: 'slug_duplicate', path: '', message: `${template.slug} appears twice in the pack` });
    seen.add(template.slug);
    const checked = checkTemplate(template, pack, categorySlugs, (issue, warn) => (warn ? warnings : issues).push({ at, ...issue }));
    if (checked) templates.push(checked);
  }
  let attestations: FormpackAttestation[] = [];
  if (source.attestations !== undefined) {
    const parsed = z.array(FormpackAttestationSchema).safeParse(source.attestations);
    if (parsed.success) attestations = parsed.data;
    else for (const issue of parsed.error.issues) issues.push({ at: ATTESTATIONS_PATH, code: 'invalid_file', path: jsonPointer(...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))), message: issue.message });
    attestations.forEach((a, i) => {
      const t = templates.find((x) => x.entry.slug === a.slug && x.entry.version === a.version);
      if (!t) issues.push({ at: ATTESTATIONS_PATH, code: 'attestation_unknown', path: jsonPointer(i), message: `${a.slug}@${a.version} is not in the pack` });
      else if (!t.file.payload.i18n.locales.some((l) => l.locale === a.locale)) {
        issues.push({ at: ATTESTATIONS_PATH, code: 'attestation_unknown', path: jsonPointer(i, 'locale'), message: `${a.slug}@${a.version} has no ${a.locale}` });
      }
    });
  }
  return { issues, warnings, templates, categories, attestations };
}

export const packFileName = (pack: Pick<PackDescriptor, 'name' | 'version'>): string => `${pack.name}-${pack.version}.formpack`;

/** Template file path inside a pack: `templates/<slug>.v<version>.json`. */
export const templatePath = (slug: string, version: number): string => `templates/${slug}.v${version}.json`;

/** `templates:build`: validate, write `<name>-<version>.formpack` with every file hashed into the manifest, and sign the manifest. */
export async function buildFormpack(source: PackSource, signer: PackSigner): Promise<BuildResult> {
  const pack = PackDescriptorSchema.omit({ templates: true }).safeParse(source.pack);
  if (!pack.success) {
    return { ok: false, warnings: [], issues: pack.error.issues.map((i) => ({ at: 'pack.json', code: 'invalid_file', path: jsonPointer(...i.path.map(String)), message: i.message })) };
  }
  const checked = validatePackSource(source);
  if (checked.issues.length) return { ok: false, issues: checked.issues, warnings: checked.warnings };

  const files = new Map<string, Uint8Array>();
  const templates = checked.templates.map(({ entry, file }) => {
    const path = templatePath(entry.slug, entry.version);
    const bytes = jsonBytes(file);
    files.set(path, bytes);
    return { ...entry, path, sha256: sha256Hex(bytes) };
  });
  const categories = jsonBytes(checked.categories);
  files.set(CATEGORIES_PATH, categories);
  const attestations = source.attestations === undefined ? undefined : jsonBytes(checked.attestations);
  if (attestations) files.set(ATTESTATIONS_PATH, attestations);
  const { publisher, name, version, minAppVersion } = pack.data;
  const manifest: FormpackManifest = FormpackManifestSchema.parse({
    format: 'fORM-template-bundle',
    formatVersion: 1,
    pack: { publisher, name, version },
    minAppVersion,
    schemaVersion: SCHEMA_VERSION,
    templates,
    categories: { path: CATEGORIES_PATH, sha256: sha256Hex(categories) },
    ...(attestations ? { attestations: { path: ATTESTATIONS_PATH, sha256: sha256Hex(attestations) } } : {}),
    assets: [],
  });
  const bytes = await writeFormpack(manifest, files, signer);
  return { ok: true, fileName: packFileName(pack.data), bytes, manifest, warnings: checked.warnings };
}
