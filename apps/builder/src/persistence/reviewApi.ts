import { z } from 'zod';
import { ReviewSettingsSchema, type ReviewSettings } from '@form/schema';
import { ApiUnreachable } from '@/auth/client';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * A form's review settings as the builder's Review tab uses them (WP-2.33): which group checks each review unit, in what
 * order, whether it is required and what its checker sees. The units themselves (what is reviewed) are in the form
 * definition and travel with the draft; this is the live half, stored on the server with a revision, like the access
 * settings. Every call names its org (`X-FR-Org`); reading needs `forms.read`, saving `ops.manage`.
 */

/** What `GET .../review` answers: the settings and the revision to send back in `If-Match`. Extra keys are ignored, as for the other form APIs. */
const viewSchema = z.object({ rev: z.number().int().min(0), ...ReviewSettingsSchema.shape });

/** A form's review settings and the revision they were read at (0: nobody has saved any yet). */
export type ReviewView = z.infer<typeof viewSchema>;

/** The settings as a save input: what the server holds, without the revision. */
export function inputOf(view: ReviewView): ReviewSettings {
  const { rev: _rev, ...input } = view;
  return input;
}

/** Someone saved the settings first (409 `REVIEW_SETTINGS_CONFLICT`): nothing was written; read them again. */
export class ReviewConflict extends Error {
  constructor() {
    super('The review settings changed since they were read.');
    this.name = 'ReviewConflict';
  }
}

/** The server refused values in a save (400): where each is and what is wrong with it. */
export class ReviewInvalid extends Error {
  readonly fields: Array<{ path: string; message: string }>;
  constructor(detail: string, fields: Array<{ path: string; message: string }>) {
    super(detail);
    this.name = 'ReviewInvalid';
    this.fields = fields;
  }
}

const url = (formId: string) => `/v1/forms/${encodeURIComponent(formId)}/review`;

function read(reply: Reply): ReviewView {
  if (!reply.ok) throw problemOf(reply);
  const parsed = viewSchema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** The field problems of a 400, as the API lists them (`errors: [{ path, message }]`, paths like `body/units/2/groupId`). */
function invalidOf(reply: Reply): ReviewInvalid | null {
  if (reply.status !== 400 || reply.json === null || typeof reply.json !== 'object') return null;
  const body = reply.json as { detail?: unknown; title?: unknown; errors?: unknown };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const fields = errors.flatMap((e): Array<{ path: string; message: string }> => {
    const entry = e as { path?: unknown; message?: unknown };
    return typeof entry.path === 'string' && typeof entry.message === 'string' ? [{ path: entry.path, message: entry.message }] : [];
  });
  return new ReviewInvalid(typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : '', fields);
}

/** The form's review settings, or the defaults (review off, no units, revision 0) for a form nobody set up. A form that is not on the server is a 404. */
export async function getReviewSettings(org: string, formId: string): Promise<ReviewView> {
  return read(await orgCall(org, 'GET', url(formId)));
}

/**
 * Saves the settings if the server is still at revision `rev` (`If-Match`). A stale revision is `ReviewConflict`; a unit or
 * a group the server does not know is `ReviewInvalid`. The answer is the settings as saved, with their new revision.
 */
export async function saveReviewSettings(org: string, formId: string, input: ReviewSettings, rev: number): Promise<ReviewView> {
  const reply = await orgCall(org, 'PUT', url(formId), input, { 'if-match': `"${rev}"` });
  if (reply.status === 409 && (reply.json as { code?: unknown } | null)?.code === 'REVIEW_SETTINGS_CONFLICT') throw new ReviewConflict();
  const invalid = invalidOf(reply);
  if (invalid) throw invalid;
  return read(reply);
}
