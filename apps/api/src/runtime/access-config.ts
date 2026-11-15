import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { formAccess, formAccessPublicColumns, type Tx } from '@form/db';
import { AccessConfigSchema, canonicalJson, type AccessConfig } from '@form/schema';

/*
 * A form's access settings as the API stores, reads and accepts them (WP-1.07): one place for the shape, so the builder
 * routes and the runtime host (WP-1.09) cannot disagree about it. Nothing here touches `password_hash`: fr_app cannot
 * select it, and a query that names its columns (`formAccessPublicColumns`) cannot leak it.
 */

export type Availability = NonNullable<AccessConfig['availability']>;
export type Screens = AccessConfig['screens'];

/** What the database holds for one form, with the dates as instants. */
export interface AccessSettings {
  /** Compare-and-swap revision; 0 for a form that has no row yet (it is open with the defaults). */
  rev: number;
  enabled: boolean;
  openAt: Date | null;
  closeAt: Date | null;
  availability: Availability | null;
  submissionLimit: number | null;
  /** `password_updated_at` is set and cleared together with the hash, by the password routes only. */
  hasPassword: boolean;
  passwordUpdatedAt: Date | null;
  embedAllowlist: string[];
  redirectAllowlist: string[] | null;
  screens: Screens;
  acceptPreviousVersionsHours: number;
}

/** A form without a `form_access` row: open, no limit, no password, previous versions accepted for 72 hours. */
export const ACCESS_DEFAULTS: AccessSettings = {
  rev: 0,
  enabled: true,
  openAt: null,
  closeAt: null,
  availability: null,
  submissionLimit: null,
  hasPassword: false,
  passwordUpdatedAt: null,
  embedAllowlist: [],
  redirectAllowlist: null,
  screens: {},
  acceptPreviousVersionsHours: 72,
};

/** The longest list of origins or hosts a form takes. */
export const MAX_ALLOWLIST = 50;
/** The most windows of weekly availability. */
export const MAX_WINDOWS = 28;

/** A time zone Intl knows (the twin's shape check only keeps out text that cannot be a zone name). */
export function isIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);

/** A DNS name in lower case: letters, digits and hyphens in labels; no scheme, port, path or wildcard. */
export const isHostname = (v: string): boolean => v.length <= 253 && HOSTNAME.test(v);

/** `https://host` or `https://host:port`, exactly what a browser sends as `Origin` (no path, no credentials, no default port). */
export function isHttpsOrigin(v: string): boolean {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.origin === v && isHostname(url.hostname);
}

const embedOrigin = z
  .string()
  .max(300)
  .transform((v) => v.trim().toLowerCase())
  .refine(isHttpsOrigin, { message: 'must be an https origin such as https://example.com, with no path' });
const redirectHost = z
  .string()
  .max(253)
  .transform((v) => v.trim().toLowerCase())
  .refine(isHostname, { message: 'must be a host name such as example.com, without a scheme, port or path' });

/*
 * The body of `PUT .../access` is the access twin (`AccessConfigSchema`, strict) without what has no column or has its
 * own route yet: `password` (set through `.../access/password`, never sent back), `uniqueSubmission` and
 * `onePerVerifiedEmail` (ACC-07, ACC-09) and `requireAuth` (P3). A key the twin lacks, or one of those, is a 400. The
 * two allowlists are narrowed (https origins, host names) and `acceptPreviousVersionsHours` joins from FormOps.
 */
const accessShape = AccessConfigSchema.omit({ password: true, uniqueSubmission: true, onePerVerifiedEmail: true, requireAuth: true }).extend({
  embedAllowlist: z.array(embedOrigin).max(MAX_ALLOWLIST),
  redirectAllowlist: z.array(redirectHost).max(MAX_ALLOWLIST).exactOptional(),
  acceptPreviousVersionsHours: z.number().int().min(0).max(720),
});

export const AccessBody = accessShape.superRefine((body, ctx) => {
  if (body.openAt !== undefined && body.closeAt !== undefined && !(Date.parse(body.closeAt) > Date.parse(body.openAt))) {
    ctx.addIssue({ code: 'custom', path: ['closeAt'], message: 'must be after openAt' });
  }
  const availability = body.availability;
  if (availability === undefined) return;
  if (!isIanaTimeZone(availability.timeZone)) {
    ctx.addIssue({ code: 'custom', path: ['availability', 'timeZone'], message: 'must be an IANA time zone such as Asia/Kolkata' });
  }
  if (availability.windows.length === 0 || availability.windows.length > MAX_WINDOWS) {
    ctx.addIssue({ code: 'custom', path: ['availability', 'windows'], message: `needs between 1 and ${MAX_WINDOWS} windows` });
  }
  for (const [i, w] of availability.windows.entries()) {
    if (w.weekdays.length === 0 || new Set(w.weekdays).size !== w.weekdays.length) {
      ctx.addIssue({ code: 'custom', path: ['availability', 'windows', i, 'weekdays'], message: 'needs at least one weekday, each once' });
    }
    if (w.from === w.to) ctx.addIssue({ code: 'custom', path: ['availability', 'windows', i, 'to'], message: 'must differ from the start of the window' });
  }
});

export type AccessInput = z.infer<typeof AccessBody>;

/**
 * The settings as the routes send them: the twin's shape (a key is left out when unset) plus the revision. Typed
 * loosely on purpose: the response is encoded with this schema, and the body's one-way transforms (lower-casing the
 * allowlists) cannot be encoded.
 */
export const AccessView = z.object({
  rev: z.number().int().min(0),
  enabled: z.boolean(),
  openAt: z.iso.datetime().exactOptional(),
  closeAt: z.iso.datetime().exactOptional(),
  availability: z
    .object({ timeZone: z.string(), windows: z.array(z.object({ weekdays: z.array(z.number().int()), from: z.string(), to: z.string() })) })
    .exactOptional(),
  submissionLimit: z.number().int().exactOptional(),
  hasPassword: z.boolean(),
  passwordUpdatedAt: z.iso.datetime().exactOptional(),
  embedAllowlist: z.array(z.string()),
  redirectAllowlist: z.array(z.string()).exactOptional(),
  screens: z.record(z.string(), z.unknown()),
  acceptPreviousVersionsHours: z.number().int(),
});

export function viewOf(s: AccessSettings): z.input<typeof AccessView> {
  return {
    rev: s.rev,
    enabled: s.enabled,
    ...(s.openAt ? { openAt: s.openAt.toISOString() } : {}),
    ...(s.closeAt ? { closeAt: s.closeAt.toISOString() } : {}),
    ...(s.availability ? { availability: s.availability } : {}),
    ...(s.submissionLimit !== null ? { submissionLimit: s.submissionLimit } : {}),
    hasPassword: s.hasPassword,
    ...(s.passwordUpdatedAt ? { passwordUpdatedAt: s.passwordUpdatedAt.toISOString() } : {}),
    embedAllowlist: s.embedAllowlist,
    ...(s.redirectAllowlist ? { redirectAllowlist: s.redirectAllowlist } : {}),
    screens: s.screens,
    acceptPreviousVersionsHours: s.acceptPreviousVersionsHours,
  };
}

/** The settings a valid body asks for, in the shapes of the columns (lists de-duplicated, weekdays sorted). */
export function settingsOfInput(input: AccessInput): Omit<AccessSettings, 'rev' | 'hasPassword' | 'passwordUpdatedAt'> {
  return {
    enabled: input.enabled,
    openAt: input.openAt === undefined ? null : new Date(input.openAt),
    closeAt: input.closeAt === undefined ? null : new Date(input.closeAt),
    availability:
      input.availability === undefined
        ? null
        : { timeZone: input.availability.timeZone, windows: input.availability.windows.map((w) => ({ weekdays: [...w.weekdays].sort((a, b) => a - b), from: w.from, to: w.to })) },
    submissionLimit: input.submissionLimit ?? null,
    embedAllowlist: [...new Set(input.embedAllowlist)],
    redirectAllowlist: input.redirectAllowlist === undefined ? null : [...new Set(input.redirectAllowlist)],
    screens: input.screens,
    acceptPreviousVersionsHours: input.acceptPreviousVersionsHours,
  };
}

/** The settings keys a save can change, in the order the audit record lists them. */
export const SETTING_KEYS = [
  'enabled',
  'openAt',
  'closeAt',
  'availability',
  'submissionLimit',
  'embedAllowlist',
  'redirectAllowlist',
  'screens',
  'acceptPreviousVersionsHours',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const comparable = (v: unknown): string => canonicalJson(v instanceof Date ? v.toISOString() : (v ?? null));

/** The keys whose value differs, for the audit record: names only, never the values (screens can hold any text). */
export function changedKeys(before: Pick<AccessSettings, SettingKey>, after: Pick<AccessSettings, SettingKey>): SettingKey[] {
  return SETTING_KEYS.filter((key) => comparable(before[key]) !== comparable(after[key]));
}

/**
 * The form's settings, or null when it has no row. Names its columns, so the password hash is never selected; with
 * `forUpdate` the row stays locked until the transaction ends (the compare-and-swap of a save reads it first).
 */
export async function loadAccess(tx: Tx, formId: string, o: { forUpdate?: boolean } = {}): Promise<AccessSettings | null> {
  const query = tx.select(formAccessPublicColumns).from(formAccess).where(eq(formAccess.formId, formId)).limit(1);
  const [row] = await (o.forUpdate ? query.for('update') : query);
  if (!row) return null;
  return {
    rev: row.rev,
    enabled: row.enabled,
    openAt: row.openAt,
    closeAt: row.closeAt,
    availability: row.availability as Availability | null,
    submissionLimit: row.submissionLimit,
    hasPassword: row.passwordUpdatedAt !== null,
    passwordUpdatedAt: row.passwordUpdatedAt,
    embedAllowlist: row.embedAllowlist,
    redirectAllowlist: row.redirectAllowlist,
    screens: row.screens as Screens,
    acceptPreviousVersionsHours: row.acceptPreviousVersionsHours,
  };
}
