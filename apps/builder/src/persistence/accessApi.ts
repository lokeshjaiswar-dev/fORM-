import { z } from 'zod';
import { ApiProblem, ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The form-access API as the builder's Access panel uses it (WP-1.07): who may open a form and when, its password and its
 * public address. Every call names its org (`X-FR-Org`) and needs `ops.manage`. The server owns all of it: a password is
 * sent once (`PUT .../access/password`) and never comes back, so the builder can show only whether one is set.
 */

/** The settings as `GET .../access` answers; a key is absent when it is unset. `screens` keeps what the server holds for every role, so a save does not drop the ones this panel does not edit. */
const accessSchema = z.object({
  rev: z.number().int().min(0),
  enabled: z.boolean(),
  openAt: z.string().optional(),
  closeAt: z.string().optional(),
  availability: z
    .object({ timeZone: z.string(), windows: z.array(z.object({ weekdays: z.array(z.number().int()), from: z.string(), to: z.string() })) })
    .optional(),
  submissionLimit: z.number().int().optional(),
  hasPassword: z.boolean(),
  passwordUpdatedAt: z.string().optional(),
  embedAllowlist: z.array(z.string()),
  redirectAllowlist: z.array(z.string()).optional(),
  screens: z.record(z.string(), z.unknown()),
  acceptPreviousVersionsHours: z.number().int(),
});

/** A form's access settings and the revision they were read at. */
export type AccessSettings = z.infer<typeof accessSchema>;
/** What `PUT .../access` takes: the settings that can be saved (a key left out is cleared). The password has its own calls. */
export type AccessInput = Omit<AccessSettings, 'rev' | 'hasPassword' | 'passwordUpdatedAt'>;

/** The settings as a save input: what the server holds, without the revision and the password's state. */
export function inputOf(settings: AccessSettings): AccessInput {
  const { rev: _rev, hasPassword: _hasPassword, passwordUpdatedAt: _passwordUpdatedAt, ...input } = settings;
  return input;
}

const passwordSchema = z.object({ hasPassword: z.boolean() });
const slugsSchema = z.object({ slug: z.string().nullable(), previousSlugs: z.array(z.string()) });
const orgSchema = z.object({ org: z.object({ timeZone: z.string() }) });

/** A form's public address and the addresses it had before. */
export type FormSlugs = z.infer<typeof slugsSchema>;

/** Someone saved the settings first (409 `ACCESS_REV_CONFLICT`): nothing was written; read them again. */
export class AccessConflict extends Error {
  constructor() {
    super('The access settings changed since they were read.');
    this.name = 'AccessConflict';
  }
}

/** The server refused values in a save (400): where each is and what is wrong with it. */
export class AccessInvalid extends Error {
  readonly fields: Array<{ path: string; message: string }>;
  constructor(detail: string, fields: Array<{ path: string; message: string }>) {
    super(detail);
    this.name = 'AccessInvalid';
    this.fields = fields;
  }
}

/** Another form holds the address (409 `FORM_SLUG_TAKEN`), as its current one or one it used to have. */
export class SlugTaken extends Error {
  constructor() {
    super('Another form already uses that address.');
    this.name = 'SlugTaken';
  }
}

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

const base = (id: string) => `/v1/forms/${encodeURIComponent(id)}`;

/** The form's access settings, or the defaults (open, no limit, revision 0) for a form nobody configured. */
export async function getAccess(org: string, formId: string): Promise<AccessSettings> {
  return read(await orgCall(org, 'GET', `${base(formId)}/access`), accessSchema);
}

/** Field problems of a 400, as the API lists them (`errors: [{ path, message }]`). */
function invalidOf(reply: Reply): AccessInvalid | null {
  if (reply.status !== 400 || reply.json === null || typeof reply.json !== 'object') return null;
  const body = reply.json as { detail?: unknown; title?: unknown; errors?: unknown };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const fields = errors.flatMap((e): Array<{ path: string; message: string }> => {
    const entry = e as { path?: unknown; message?: unknown };
    return typeof entry.path === 'string' && typeof entry.message === 'string' ? [{ path: entry.path, message: entry.message }] : [];
  });
  return new AccessInvalid(typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : '', fields);
}

/**
 * Saves the settings if the server is still at revision `rev` (`If-Match`). A stale revision is `AccessConflict`; values
 * the server refuses are `AccessInvalid`. The answer is the settings as saved, with their new revision.
 */
export async function saveAccess(org: string, formId: string, input: AccessInput, rev: number): Promise<AccessSettings> {
  const reply = await orgCall(org, 'PUT', `${base(formId)}/access`, input, { 'if-match': `"${rev}"` });
  if (reply.status === 409 && (reply.json as { code?: unknown } | null)?.code === 'ACCESS_REV_CONFLICT') throw new AccessConflict();
  const invalid = invalidOf(reply);
  if (invalid) throw invalid;
  return read(reply, accessSchema);
}

/** Sets or replaces the respondent password. It is hashed on the server; nothing comes back but whether one is set. */
export async function setFormPassword(org: string, formId: string, password: string): Promise<void> {
  read(await orgCall(org, 'PUT', `${base(formId)}/access/password`, { password }), passwordSchema);
}

/** Removes the respondent password (a form without one stays without). */
export async function removeFormPassword(org: string, formId: string): Promise<void> {
  read(await orgCall(org, 'DELETE', `${base(formId)}/access/password`), passwordSchema);
}

export async function getSlugs(org: string, formId: string): Promise<FormSlugs> {
  return read(await orgCall(org, 'GET', `${base(formId)}/slug`), slugsSchema);
}

/** Makes `slug` the form's address (the old one keeps resolving). Another form's address is `SlugTaken`. */
export async function changeSlug(org: string, formId: string, slug: string): Promise<FormSlugs> {
  const reply = await orgCall(org, 'PUT', `${base(formId)}/slug`, { slug });
  if (reply.status === 409 && (reply.json as { code?: unknown } | null)?.code === 'FORM_SLUG_TAKEN') throw new SlugTaken();
  const invalid = invalidOf(reply);
  if (invalid) throw invalid;
  return read(reply, slugsSchema);
}

/** The org's time zone (`GET /v1/org`): the zone an author's open and close times are read in. */
export async function getOrgTimeZone(org: string): Promise<string> {
  return read(await orgCall(org, 'GET', '/v1/org'), orgSchema).org.timeZone;
}

/** Whether a refusal says the form is not on the server yet (404): a form made here that has not been saved. */
export const isNotOnServer = (err: unknown): boolean => err instanceof ApiProblem && err.status === 404;
