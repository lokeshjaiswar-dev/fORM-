import { compile, projectForRuntime } from '@form/logic';
import { REGISTRY } from '@form/registry';
import {
  htmlToInline, htmlToPlain, migrateV1ToV2, parseV1,
  type CountryCode, type FileRef, type FileId, type FormDefinition, type FormVersion, type FormVersionId, type IsoInstant, type Locale,
  type OrgId, type PublishIssue, type RichDoc, type RuntimeFormVersion, type RuntimeStatus, type Sha256Hex, type TimeZone, type UserId,
  type V1, type V1MigrationResult,
} from '@form/schema';
import type { UploadRequest } from '@form/renderer';
import { patternProblem } from '@form/validation';
import type { FormSchema } from '@/types/form';

/*
 * The builder preview runs the published path locally (WP-0.10): the v1 store document goes through migrate() like a
 * load does, then compile() and projectForRuntime() like a publish does, and @form/renderer shows the result. Nothing
 * here touches the network.
 */

const EMPTY: RichDoc = { type: 'doc', content: [] };

/** Sequential ids, so the same document always migrates to the same ids (stable keys while the author edits). */
function sequence(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

export interface PreviewDraft {
  definition: FormDefinition;
  /** What the runtime would answer `/session` with: closed (FormOps access) or password-protected (S5). */
  status: RuntimeStatus;
  /** The v1 password, compared locally to unlock the preview; the API hashes it and never stores it (S5). */
  password?: string;
}

/** `migrateV1ToV2` with the builder's context: a v1 form as the v2 definition, ops and notes a load would produce. */
export function migrateForBuilder(form: V1.FormSchema, now: IsoInstant): V1MigrationResult {
  return migrateV1ToV2(form, {
    idFactory: sequence('pv'),
    now,
    orgDefaults: { locale: 'en-IN' as Locale, timeZone: 'Asia/Kolkata' as TimeZone, country: 'IN' as CountryCode },
    htmlToInline,
    htmlToPlain,
    isSafePattern: (source) => patternProblem({ source }) === null,
    registry: REGISTRY,
  });
}

/** The v1 builder document as the v2 definition a load would produce (schema §4.2). */
export function previewDraft(form: FormSchema, now: IsoInstant): PreviewDraft {
  const parsed = parseV1(form);
  if (!parsed.success) throw new Error(`preview: ${parsed.error}`);
  const result = migrateForBuilder(parsed.data, now);
  const access = result.ops.access;
  const status: RuntimeStatus = !access.enabled
    ? { state: 'closed', screen: access.screens.closed?.content ?? EMPTY }
    : result.plaintextPasswordToHash !== undefined ? { state: 'password', screen: EMPTY } : { state: 'open' };
  return { definition: result.definition, status, ...(result.plaintextPasswordToHash !== undefined ? { password: result.plaintextPasswordToHash } : {}) };
}

export type PreviewBuild = { ok: true; version: RuntimeFormVersion } | { ok: false; issues: PublishIssue[] };

/** compile() and projectForRuntime() over a draft, as publish would; issues instead when the engine refuses it. */
export function previewVersion(definition: FormDefinition, status: RuntimeStatus, now: IsoInstant): PreviewBuild {
  const compiled = compile(definition, REGISTRY);
  if (!compiled.ok) return { ok: false, issues: compiled.issues };
  const version: FormVersion = {
    id: 'preview' as FormVersionId,
    orgId: 'preview' as OrgId,
    formId: definition.formId,
    number: 0,
    schemaVersion: definition.schemaVersion,
    publishedAt: now,
    publishedBy: 'preview' as UserId,
    definition,
    compiled: compiled.compiled,
    contentHash: compiled.compiled.definitionHash,
    templateLineage: [],
    variablesSnapshot: { variables: {} },
  };
  return {
    ok: true,
    version: projectForRuntime(version, status, {
      edition: 'saas',
      upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 },
      branding: false,
      thirdPartyTrackingAllowed: false,
    }),
  };
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Keeps preview files in the page: a reference with a real SHA-256, nothing uploaded. */
export async function previewUploader({ file, name }: UploadRequest): Promise<FileRef> {
  const digest = globalThis.crypto?.subtle ? hex(await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())) : '0'.repeat(64);
  return {
    fileId: globalThis.crypto.randomUUID() as FileId,
    name,
    sizeBytes: file.size,
    mime: file.type || 'application/octet-stream',
    sha256: digest as Sha256Hex,
    scan: 'skipped',
  };
}
