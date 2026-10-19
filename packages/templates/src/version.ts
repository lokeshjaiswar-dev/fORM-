import { contentHash } from '@form/schema';
import type {
  FormpackManifest, FormpackSignature, FormpackTemplateFile, IsoInstant, Locale, TemplateId, TemplateVersion, TemplateVersionId, TemplateVersionPayload,
} from '@form/schema';
import { seedNamespace, uuidv5 } from '@form/templates-core';
import type { FormpackTemplateEntry } from './formpack.ts';

/** Template and version ids of pack templates: `uuidv5(PACK_NAMESPACE, '<publisher>/<pack>/<slug>[@<version>]')`, the same on every reader. */
export const PACK_NAMESPACE = seedNamespace('fORM-template-pack');

export const packTemplateId = (pack: FormpackManifest['pack'], slug: string): TemplateId => uuidv5(PACK_NAMESPACE, `${pack.publisher}/${pack.name}/${slug}`) as TemplateId;

export const packTemplateVersionId = (pack: FormpackManifest['pack'], slug: string, version: number): TemplateVersionId =>
  uuidv5(PACK_NAMESPACE, `${pack.publisher}/${pack.name}/${slug}@${version}`) as TemplateVersionId;

function stats(payload: TemplateVersionPayload): TemplateVersion['stats'] {
  if (payload.kind !== 'form') return { fields: 0, pages: 0, estMinutes: 0, hasSensitive: false };
  const fields = Object.values(payload.document.blocks).filter((b) => b !== undefined && 'compliance' in b);
  return {
    fields: fields.length,
    pages: payload.document.pages.length,
    estMinutes: payload.estimatedMinutes,
    hasSensitive: fields.some((b) => 'compliance' in b && b.compliance.classification === 'sensitive'),
  };
}

/** What `packTemplateVersion` reads of a pack: its identity and, once signed, its signature. */
export interface PackOf { manifest: Pick<FormpackManifest, 'pack'>; signature?: FormpackSignature }

/**
 * A pack template as the published `TemplateVersion` row `instantiate()` takes: system scope (`orgId: null`), the pack's
 * signature, and `now` as its creation time (the pack carries none). The offline builder uses it as it is; the seed job
 * (WP-T1.2) writes the same ids.
 */
export function packTemplateVersion(
  pack: PackOf, template: { entry: Pick<FormpackTemplateEntry, 'slug' | 'version' | 'requiredFeatures'>; file: FormpackTemplateFile }, now: IsoInstant,
): TemplateVersion {
  const { entry, file } = template;
  const { payload } = file;
  return {
    id: packTemplateVersionId(pack.manifest.pack, entry.slug, entry.version),
    templateId: packTemplateId(pack.manifest.pack, entry.slug),
    orgId: null,
    version: entry.version,
    state: 'published',
    schemaVersion: payload.schemaVersion,
    payload,
    payloadHash: contentHash(payload),
    lockFingerprints: {},
    requiredFeatures: entry.requiredFeatures,
    locales: payload.i18n.locales.map((l) => l.locale),
    ...(file.changelog !== undefined ? { changelog: file.changelog } : {}),
    mandatory: false,
    stats: stats(payload),
    publishedAt: now,
    ...(pack.signature ? { packSignature: { keyId: pack.signature.keyId, sig: pack.signature.sig } } : {}),
    createdAt: now,
  };
}

/** The gallery text of a pack template in `locale`, else its default locale, else the first it has. */
export function localizationOf(file: FormpackTemplateFile, locale: Locale): FormpackTemplateFile['localizations'][number] | undefined {
  return file.localizations.find((l) => l.locale === locale)
    ?? file.localizations.find((l) => l.locale === file.payload.i18n.defaultLocale)
    ?? file.localizations[0];
}
