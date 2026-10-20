import type { TemplateKind, TemplateScope, TemplateVersionState } from '@form/schema';
import { sql } from 'drizzle-orm';
import type { Executor } from './client.ts';

/** Typed calls of the template definer functions in migration 0009. */

export interface BoundTemplate {
  bindingId: string;
  formId: string;
  templateId: string;
  templateVersionId: string;
  /** null for a system template. */
  templateOrgId: string | null;
  scope: TemplateScope;
  kind: TemplateKind;
  slug: string;
  version: number;
  state: TemplateVersionState;
  schemaVersion: number;
  payload: Record<string, unknown>;
  payloadHash: Uint8Array;
  lockFingerprints: Record<string, string>;
  /** Set when the template was soft-deleted after it was applied. */
  templateDeletedAt: Date | null;
}

type BoundTemplateRow = {
  binding_id: string;
  form_id: string;
  template_id: string;
  template_version_id: string;
  template_org_id: string | null;
  scope: TemplateScope;
  kind: TemplateKind;
  slug: string;
  version: number;
  state: TemplateVersionState;
  schema_version: number;
  payload: Record<string, unknown>;
  payload_hash: Buffer;
  lock_fingerprints: Record<string, string>;
  template_deleted_at: string | Date | null;
};

/**
 * The template version a binding of the current org points at, also when its template was soft-deleted (diffs and
 * lineage, templates spec §5.2). null for another org's binding, an unknown id, or an actor that reads no templates.
 */
export async function templateForBinding(db: Executor, bindingId: string): Promise<BoundTemplate | null> {
  const { rows } = await db.execute<BoundTemplateRow>(sql`select * from template_for_binding(${bindingId}::uuid)`);
  const r = rows[0];
  if (!r) return null;
  return {
    bindingId: r.binding_id,
    formId: r.form_id,
    templateId: r.template_id,
    templateVersionId: r.template_version_id,
    templateOrgId: r.template_org_id,
    scope: r.scope,
    kind: r.kind,
    slug: r.slug,
    version: r.version,
    state: r.state,
    schemaVersion: r.schema_version,
    payload: r.payload,
    payloadHash: new Uint8Array(r.payload_hash),
    lockFingerprints: r.lock_fingerprints,
    templateDeletedAt: r.template_deleted_at === null ? null : new Date(r.template_deleted_at),
  };
}

/** Soft-deletes a template the caller can see; false when there is none. */
export async function deleteTemplate(db: Executor, templateId: string): Promise<boolean> {
  const { rows } = await db.execute<{ deleted: boolean }>(sql`select template_delete(${templateId}::uuid) as deleted`);
  return rows[0]?.deleted === true;
}
