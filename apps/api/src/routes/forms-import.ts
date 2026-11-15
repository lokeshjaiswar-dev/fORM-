import { eq } from 'drizzle-orm';
import { audit, auditActor, formAccess, formDrafts, forms, ORG_DEFAULTS, orgs, withTenant, type Db, type TenantCtx } from '@form/db';
import { REGISTRY } from '@form/registry';
import {
  FormDefinitionSchema,
  htmlToInline,
  htmlToPlain,
  migrateV1ToV2,
  parseV1,
  type CountryCode,
  type IsoInstant,
  type Locale,
  type MigrationContext,
  type TimeZone,
} from '@form/schema';
import { patternProblem } from '@form/validation';
import { z } from 'zod';
import { ProblemError } from '../errors.ts';
import { hashPassword } from '../modules/auth/passwords.ts';
import { uuidv7 } from '../uuid7.ts';

/**
 * `POST /v1/forms` with `from: 'importV1'` (WP-1.06, BL-107): a v1 form (the JSON an older builder saved or exported)
 * becomes a v2 draft on the server. The migration runs here, not in the browser, because it returns things that must not
 * be stored in the draft: the form password (S5) and the open/closed state (ops). The password is hashed with argon2id
 * and written to `form_access.password_hash` in the same transaction as the draft, so there is no moment when the
 * draft exists and the password is neither hashed nor gone, and no copy of the plaintext anywhere.
 */

export const importBody = z.strictObject({
  from: z.literal('importV1'),
  /** The v1 form as the lenient v1 reader accepts it; unknown keys and bad values are repaired and reported, not stored. */
  v1: z.unknown(),
  /** Optional, so a retry after a lost answer finds the form it already made instead of making a second one. */
  id: z.uuid().optional(),
});

export const importNote = z.object({ path: z.string(), code: z.string(), detail: z.string() });

/** What the answer to an import adds to `{ id }`. */
export const importResult = z.object({
  notes: z.array(importNote),
  /** False when the form came in closed (v1 `closed`). */
  enabled: z.boolean(),
  hasPassword: z.boolean(),
});

/** The audit fields that come from the HTTP request (session, hashed IP, user agent), explicit so every event names them. */
export interface AuditClient {
  sessionId: string | null;
  actorIpHash: string;
  actorUa: string | null;
}

const MAX_DRAFT_BYTES = 5_242_880;

function migrationContext(org: { locale: string; timeZone: string }, now: Date): MigrationContext {
  return {
    idFactory: () => uuidv7(),
    now: now.toISOString() as IsoInstant,
    orgDefaults: { locale: org.locale as Locale, timeZone: org.timeZone as TimeZone, country: 'IN' as CountryCode },
    htmlToInline,
    htmlToPlain,
    isSafePattern: (source) => patternProblem({ source }) === null,
    registry: REGISTRY,
  };
}

export async function importV1Form(
  deps: { db: Db; now: () => Date },
  tenant: TenantCtx,
  userId: string,
  client: AuditClient,
  body: { v1: unknown; id?: string | undefined },
): Promise<{ id: string } & z.infer<typeof importResult>> {
  const read = parseV1(body.v1);
  if (!read.success) throw new ProblemError('IMPORT_INVALID', read.error);

  // The server names the form unless the client asked for an id to retry with (a v1 id is never used: it is not trusted).
  const id = body.id ?? uuidv7();
  const now = deps.now();
  const org = await withTenant(deps.db, { ...tenant, readOnly: true }, async (tx) => {
    const rows = await tx.select({ locale: orgs.locale, timeZone: orgs.timeZone }).from(orgs).where(eq(orgs.id, tenant.orgId)).limit(1);
    return rows[0] ?? { locale: ORG_DEFAULTS.locale, timeZone: ORG_DEFAULTS.timeZone };
  });

  const migrated = migrateV1ToV2({ ...read.data, id }, migrationContext(org, now));
  // The strict twin is the last gate: it has no `password` key, so a password that rode along anywhere in the
  // definition would be refused here instead of stored.
  const parsed = FormDefinitionSchema.safeParse(migrated.definition);
  if (!parsed.success) throw new ProblemError('IMPORT_INVALID', 'The form could not be converted to the current format.');
  const definition = parsed.data;
  if (definition.formId !== id) throw new ProblemError('IMPORT_INVALID', 'The form could not be converted to the current format.');
  const draft = definition as unknown as Record<string, unknown>;
  const sizeBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
  if (sizeBytes > MAX_DRAFT_BYTES) throw new ProblemError('PAYLOAD_TOO_LARGE', 'The form is larger than 5 MB.');
  const title = definition.title.trim() || 'Untitled form';

  // Before the transaction: argon2id takes 64 MiB and tens of milliseconds, which a database connection should not wait through.
  const passwordHash = migrated.plaintextPasswordToHash ? await hashPassword(migrated.plaintextPasswordToHash) : null;
  const { enabled, screens } = migrated.ops.access;

  await withTenant(deps.db, tenant, async (tx) => {
    const inserted = await tx
      .insert(forms)
      .values({ id, orgId: tenant.orgId, teamId: tenant.orgId, ownerUserId: userId, title, updatedAt: now, updatedBy: userId })
      .onConflictDoNothing({ target: forms.id })
      .returning({ id: forms.id });
    // An id that already exists (this org's form from an earlier try, or another org's, which RLS hides) is left alone:
    // nothing is overwritten and no password is written to a form this request did not create.
    if (!inserted[0]) return;
    await tx.insert(formDrafts).values({ formId: id, orgId: tenant.orgId, draft, draftRev: 1, schemaVersion: 2, sizeBytes, updatedBy: userId, updatedAt: now });
    await tx.insert(formAccess).values({
      formId: id,
      orgId: tenant.orgId,
      enabled,
      screens: screens as Record<string, unknown>,
      passwordHash,
      passwordUpdatedAt: passwordHash ? now : null,
    });
    await audit.append(tx, tenant.orgId, {
      ...auditActor(tenant),
      sessionId: client.sessionId,
      actorIpHash: client.actorIpHash,
      actorUa: client.actorUa,
      action: 'form.imported',
      resourceType: 'form',
      resourceId: id,
      formId: id,
      outcome: 'success',
      metadata: { passwordHashed: passwordHash !== null, closed: !enabled, notes: migrated.notes.length },
    });
  });
  return { id, notes: migrated.notes, enabled, hasPassword: passwordHash !== null };
}
