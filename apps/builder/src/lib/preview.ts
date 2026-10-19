import type { RuntimeEdition } from '@form/config';
import { compile, projectForRuntime } from '@form/logic';
import { REGISTRY } from '@form/registry';
import type {
  FileId, FileRef, FormDefinition, FormVersion, FormVersionId, IsoInstant, OrgId, PublishIssue, RichDoc, RuntimeFormVersion, RuntimeStatus, Sha256Hex, UserId,
} from '@form/schema';
import type { UploadRequest } from '@form/renderer';
import { uid } from '@/lib/utils';
import type { LocalOps } from '@/state/opsStore';

/*
 * The builder preview runs the published path locally (WP-0.10): the v2 draft goes through compile() and
 * projectForRuntime() as a publish does, and @form/renderer shows the result. Nothing here touches the network.
 */

const EMPTY: RichDoc = { type: 'doc', content: [] };

/** What the runtime would answer `/session` with for the form's local FormOps: closed, password-protected or open. */
export function previewStatus(ops: LocalOps): RuntimeStatus {
  if (!ops.open) return { state: 'closed', screen: ops.closedMessage };
  return ops.password ? { state: 'password', screen: EMPTY } : { state: 'open' };
}

export type PreviewBuild = { ok: true; version: RuntimeFormVersion } | { ok: false; issues: PublishIssue[] };

/**
 * compile() and projectForRuntime() over a draft, as publish would; issues instead when the engine refuses it. `edition`
 * is the deployment's (air-gapped while it is unknown, like every edition check in the builder).
 */
export function previewVersion(definition: FormDefinition, status: RuntimeStatus, now: IsoInstant, edition: RuntimeEdition = 'airgapped'): PreviewBuild {
  let compiled;
  try {
    compiled = compile(definition, REGISTRY);
  } catch (e) {
    /* An engine bug must not take the builder down with it: the preview says why it cannot show the form (BL-140). */
    return { ok: false, issues: [{ severity: 'error', code: 'unknown_block_type', path: '', message: e instanceof Error ? e.message : String(e) }] };
  }
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
      edition,
      upload: { presignUrl: '', maxFileBytes: 10 * 1024 * 1024 },
      branding: false,
      thirdPartyTrackingAllowed: false,
    }),
  };
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Keeps preview files in the page: a reference with a real SHA-256 (when the context allows it), nothing uploaded. */
export async function previewUploader({ file, name }: UploadRequest): Promise<FileRef> {
  const digest = globalThis.crypto?.subtle ? hex(await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())) : '0'.repeat(64);
  return {
    fileId: uid() as FileId,
    name,
    sizeBytes: file.size,
    mime: file.type || 'application/octet-stream',
    sha256: digest as Sha256Hex,
    scan: 'skipped',
  };
}
