import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { RuntimeEdition } from '@form/config';
import { formVersions, withTenant, type Db } from '@form/db';
import { projectForRuntime } from '@form/logic';
import type { CompiledForm, FormDefinition, FormId, FormVersion, FormVersionId, IsoInstant, OrgId, RuntimeFormVersion, Sha256Hex, UserId } from '@form/schema';
import { MAX_UPLOAD_BYTES } from '../files.ts';
import { WeightedCache } from '../weighted-cache.ts';

/**
 * Published versions as the public routes use them (the page's projection, and the stored definition the server checks
 * answers against). A version never changes, so what is loaded for a version id is good for as long as it is kept; the
 * cache is bounded in entries and in memory, and a version of another form or org is never handed out for an id.
 */

/** A published version, loaded once and shared by every request that names it. */
export interface LoadedVersion {
  orgId: string;
  formId: string;
  versionId: string;
  /** The version's number within its form (`meta.versionNumber` of what is submitted to it). */
  number: number;
  /** sha256 of the version's definition, as bytes: what `submissions.definition_hash` records. */
  definitionHash: Buffer;
  definition: FormDefinition;
  compiled: CompiledForm;
  /** The page's projection with the status `open`: a request puts its own status on a copy of it. */
  runtime: RuntimeFormVersion;
  /** The theme's pictures by key (data URLs), sent beside the projection, or null. */
  media: Record<string, string> | null;
}

/** What a request knows about the form it names, from `resolveFormSlug` (the org comes from the slug, never from the caller). */
export interface FormRef {
  orgId: string;
  formId: string;
}

export interface VersionLoader {
  /**
   * The version `versionId` of the form `ref`, or null when the form has no such version. A version of another form or
   * org answers null, whatever the id.
   */
  get(ref: FormRef, versionId: string, requestId: string): Promise<LoadedVersion | null>;
}

/** Entries kept at most. */
const CACHE_MAX = 200;
/** The memory the cached versions may hold, as `loadedWeight` counts it: the pictures of a version are most of it. */
const CACHE_BYTES = 24 * 1024 * 1024;

/**
 * A version's `content_hash` (the hex of the sha256 of its definition) as the 32 bytes `submissions.definition_hash`
 * holds. A stored value that is not 64 hex digits (nothing the publish route writes) is hashed as text, as migration
 * 0021 does for the rows it moved, so a submission is never refused over how an old version spelled its hash.
 */
export function definitionHashBytes(contentHash: string): Buffer {
  return /^[0-9a-f]{64}$/.test(contentHash) ? Buffer.from(contentHash, 'hex') : createHash('sha256').update(contentHash).digest();
}

/**
 * About what keeping a version costs: the pictures (a character of a data URL is a byte), and the definition, its
 * compilation and the page's projection of it, counted as twice the JSON of the first two (JS strings and objects
 * weigh more than their JSON). Heavy enough to bound memory, cheap enough to compute once per load.
 */
function loadedWeight(definition: unknown, compiled: unknown, media: Record<string, string> | null): number {
  const pictures = media ? Object.values(media).reduce((sum, dataUrl) => sum + dataUrl.length, 0) : 0;
  return pictures + 2 * (JSON.stringify(definition).length + JSON.stringify(compiled).length);
}

export function createVersionLoader(deps: { db: Db; edition: RuntimeEdition }): VersionLoader {
  const cache = new WeightedCache<LoadedVersion>(CACHE_MAX, CACHE_BYTES);
  // Keyed by form and version, not by version alone: a request for a version under the wrong form must not share the
  // answer (or a miss) of the request that named the right one.
  const inflight = new Map<string, Promise<LoadedVersion | null>>();

  async function read(ref: FormRef, versionId: string, requestId: string): Promise<LoadedVersion | null> {
    // A respondent reads one version of one org's form: the org comes from the slug, never from the caller.
    const rows = await withTenant(deps.db, { orgId: ref.orgId, actor: 'respondent', requestId, readOnly: true }, (tx) =>
      tx
        .select({
          id: formVersions.id,
          orgId: formVersions.orgId,
          formId: formVersions.formId,
          number: formVersions.number,
          schemaVersion: formVersions.schemaVersion,
          publishedAt: formVersions.publishedAt,
          publishedBy: formVersions.publishedBy,
          definition: formVersions.definition,
          compiled: formVersions.compiled,
          contentHash: formVersions.contentHash,
          media: formVersions.media,
        })
        .from(formVersions)
        .where(and(eq(formVersions.id, versionId), eq(formVersions.formId, ref.formId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    const version: FormVersion = {
      id: row.id as FormVersionId,
      orgId: row.orgId as OrgId,
      formId: row.formId as FormId,
      number: row.number,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt.toISOString() as IsoInstant,
      publishedBy: row.publishedBy as UserId,
      definition: row.definition as unknown as FormDefinition,
      compiled: row.compiled as unknown as CompiledForm,
      contentHash: row.contentHash as Sha256Hex,
      templateLineage: [],
      variablesSnapshot: { variables: {} },
    };
    const loaded: LoadedVersion = {
      orgId: row.orgId,
      formId: row.formId,
      versionId: row.id,
      number: row.number,
      definitionHash: definitionHashBytes(row.contentHash),
      definition: version.definition,
      compiled: version.compiled,
      runtime: projectForRuntime(version, { state: 'open' }, {
        edition: deps.edition,
        upload: { presignUrl: '', maxFileBytes: MAX_UPLOAD_BYTES },
        branding: false,
        thirdPartyTrackingAllowed: false,
      }),
      media: row.media ?? null,
    };
    cache.set(row.id, loaded, loadedWeight(row.definition, row.compiled, row.media));
    return loaded;
  }

  return {
    async get(ref, versionId, requestId) {
      const cached = cache.get(versionId);
      if (cached) return cached.formId === ref.formId && cached.orgId === ref.orgId ? cached : null;
      const key = `${ref.formId}:${versionId}`;
      const pending = inflight.get(key);
      if (pending) return pending;
      const load = read(ref, versionId, requestId).finally(() => inflight.delete(key));
      inflight.set(key, load);
      return load;
    },
  };
}
