import { z } from 'zod';
import { ApiProblem, ApiUnreachable, ORG_HEADER } from '@/auth/client';
import { API_BASE } from '@/edition/edition';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * The builder's side of the exports API (WP-1.17, apps/api/src/routes/exports.ts): ask for a CSV or XLSX export of a
 * form's responses, poll it until the worker has built the file, and fetch the file. Every call names its org
 * (`X-FR-Org`) and needs `submissions.export`.
 *
 * One member action is one `Idempotency-Key`: the key is made when the member presses Start and is sent again whenever the
 * same action is retried (a request that never got an answer may or may not have been stored), so a retry finds the export
 * it already made instead of making a second one. A new action, or a changed request, gets a new key.
 */

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The permission that shows the Export menu; the API checks it again on every call. */
export const EXPORT_PERMISSION = 'submissions.export';

/** The most responses one `selected` export names (the API refuses more). */
export const MAX_SELECTED = 1000;

/** Which responses an export covers: all of them, the ones named, or those received in a range (ISO instants, either end open). */
export type ExportScope = { kind: 'all' } | { kind: 'selected'; ids: readonly string[] } | { kind: 'filtered'; from?: string | undefined; to?: string | undefined };

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
  /** Write encrypted and sensitive fields in full instead of masked. Needs `reason`. */
  includeSensitive?: boolean | undefined;
  reason?: string | undefined;
}

const exportSchema = z.object({
  id: z.string(),
  formId: z.string(),
  format: z.enum(EXPORT_FORMATS),
  scope: z.object({ kind: z.string(), count: z.number().optional(), from: z.string().optional(), to: z.string().optional() }),
  includeSensitive: z.boolean(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  rowCount: z.number().nullable(),
  bytes: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

/** An export as the API reports it. */
export type ExportState = z.infer<typeof exportSchema>;

const orgSchema = z.object({ permissions: z.array(z.string()) });

/** A finished export, fetched: the bytes and the name the server gave them. */
export interface ExportFile {
  blob: Blob;
  name: string;
}

/** The worker could not build the file (`failed`): `reason` is what it recorded, scrubbed, when it said anything. */
export class ExportFailed extends Error {
  readonly reason: string | null;
  constructor(reason: string | null) {
    super(reason ?? 'The export failed.');
    this.name = 'ExportFailed';
    this.reason = reason;
  }
}

/** The file was kept for 24 hours and is gone (`expired`): a new export is a new request. */
export class ExportExpired extends Error {
  constructor() {
    super('The export has expired.');
    this.name = 'ExportExpired';
  }
}

/** The export is still being built after the longest wait the builder allows. It keeps building: asking again with the same key picks it up. */
export class ExportTimedOut extends Error {
  constructor() {
    super('The export is taking longer than expected.');
    this.name = 'ExportTimedOut';
  }
}

/** A key for one member action, which the action's retries send again. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

/** Whether the member's role in `org` carries `submissions.export` (`GET /v1/org` lists what it grants). */
export async function canExport(org: string): Promise<boolean> {
  return read(await orgCall(org, 'GET', '/v1/org'), orgSchema).permissions.includes(EXPORT_PERMISSION);
}

/** What goes on the wire: sensitive fields and their reason only when asked for, so a plain request is just format and scope. */
function bodyOf(request: ExportRequest): Record<string, unknown> {
  const scope = request.scope;
  return {
    format: request.format,
    scope: scope.kind === 'selected' ? { kind: 'selected', ids: [...scope.ids] } : scope.kind === 'filtered' ? { kind: 'filtered', ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) } : { kind: 'all' },
    ...(request.includeSensitive ? { includeSensitive: true, reason: (request.reason ?? '').trim() } : {}),
  };
}

/**
 * Asks for an export. `key` is the `Idempotency-Key` of the member's action: the same key with the same request returns the
 * export that was made the first time and enqueues nothing.
 */
export async function requestExport(org: string, formId: string, request: ExportRequest, key: string): Promise<ExportState> {
  const reply = await orgCall(org, 'POST', `/v1/forms/${encodeURIComponent(formId)}/exports`, bodyOf(request), { 'idempotency-key': key });
  return read(reply, exportSchema);
}

/** The state of an export the member asked for. */
export async function getExport(org: string, id: string): Promise<ExportState> {
  return read(await orgCall(org, 'GET', `/v1/exports/${encodeURIComponent(id)}`), exportSchema);
}

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

/** `filename="…"` of a `Content-Disposition`, which the API makes ASCII-only. */
function nameFrom(disposition: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? fallback;
}

/** Fetches the finished file through the API (it is never a link to the object store). */
export async function downloadExport(org: string, id: string, format: ExportFormat, signal?: AbortSignal): Promise<ExportFile> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/exports/${encodeURIComponent(id)}/download`, {
      method: 'GET',
      credentials: 'include',
      headers: { [ORG_HEADER]: org },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiUnreachable();
  }
  if (!res.ok) {
    const json: unknown = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : null;
    throw problemOf({ status: res.status, ok: false, json });
  }
  const blob = await res.blob();
  return { blob, name: nameFrom(res.headers.get('content-disposition'), `responses.${format}`) };
}

/** Hands the browser the file as a download, the way the account export does (a blob link: no navigation, nothing for the CSP to refuse). */
export function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // The browser reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Waits `ms`, or throws the signal's abort. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The pauses between polls: quick at first (a small export is ready in seconds), then every five seconds. */
const POLL_DELAYS_MS = [1000, 1500, 2000, 3000] as const;
const POLL_STEADY_MS = 5000;
/** A build is minutes at the most (100,000 rows in under two); past this the page stops waiting, and the export carries on. */
const MAX_WAIT_MS = 10 * 60_000;
/** Answers that mean "try again in a moment": the API is unreachable, or a proxy or the pressure guard said so. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const ATTEMPTS = 3;

const isTransient = (err: unknown): boolean => err instanceof ApiUnreachable || (err instanceof ApiProblem && TRANSIENT_STATUSES.has(err.status));

export interface RunExportOptions {
  org: string;
  formId: string;
  request: ExportRequest;
  /** The member action's `Idempotency-Key` (`newIdempotencyKey()`): every retry of the request below sends it again. */
  key: string;
  signal?: AbortSignal | undefined;
  /** Called with the export as the API last reported it (queued, running, then ready). */
  onState?: ((state: ExportState) => void) | undefined;
  /** Called once the export is ready and the file is being fetched. */
  onDownloading?: (() => void) | undefined;
  /** How the pauses are waited (a test passes one that does not wait). */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

/**
 * One member action, start to finish: asks for the export (again, with the same key, if the answer was lost or the API
 * said "try again"), polls `GET /v1/exports/:id` until it is `ready`, `failed` or `expired`, and fetches the file when it is
 * ready. A `failed` export throws `ExportFailed` and an `expired` one `ExportExpired`; a refusal from the API (a role
 * without the permission, a quota) is thrown as the `ApiProblem` it is. Polling stops as soon as the signal aborts.
 */
export async function runExport(o: RunExportOptions): Promise<ExportFile> {
  const sleep = o.sleep ?? wait;

  let state: ExportState | undefined;
  for (let attempt = 1; state === undefined; attempt += 1) {
    try {
      state = await requestExport(o.org, o.formId, o.request, o.key);
    } catch (err) {
      if (!isTransient(err) || attempt >= ATTEMPTS || o.signal?.aborted) throw err;
      await sleep(500 * attempt, o.signal);
    }
  }
  o.onState?.(state);

  let waited = 0;
  let polls = 0;
  let misses = 0;
  while (state.status === 'queued' || state.status === 'running') {
    if (waited >= MAX_WAIT_MS) throw new ExportTimedOut();
    const delay = POLL_DELAYS_MS[polls] ?? POLL_STEADY_MS;
    polls += 1;
    waited += delay;
    await sleep(delay, o.signal);
    try {
      state = await getExport(o.org, state.id);
      misses = 0;
    } catch (err) {
      // A poll that gets no answer is asked again; the export is being built either way. Three in a row is an outage.
      misses += 1;
      if (!isTransient(err) || misses >= ATTEMPTS) throw err;
      continue;
    }
    o.onState?.(state);
  }

  if (state.status === 'failed') throw new ExportFailed(state.error);
  if (state.status === 'expired') throw new ExportExpired();
  o.onDownloading?.();
  return downloadExport(o.org, state.id, state.format, o.signal);
}
