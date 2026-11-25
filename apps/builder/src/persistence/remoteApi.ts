import { z } from 'zod';
import type { ChoiceOption } from '@form/schema';
import type { ApiAuth, ApiRequestConfig } from '@form/schema';
import type { RemoteSource } from '@form/renderer';
import { ApiUnreachable } from '@/auth/client';
import { API_BASE } from '@/edition/edition';
import { orgCall, problemOf, type Reply } from '@/persistence/draftsApi';

/*
 * Everything the builder says to the fORM- API about lookups (server-side lookups, contract sections 2 and 3):
 *   - the respondent's proxy source: the public page asks `POST /v1/p/:slug/lookups|fields/...` with a version id and the
 *     access token, and nothing else. The server holds the URL, the keys and the credential;
 *   - the author's test call (`POST /v1/forms/:formId/remote/test`), used by the Test buttons and the preview;
 *   - the org's API credentials (`/v1/org/api-credentials`). The secret is sent once, when a credential is saved or rotated,
 *     and no call ever returns it.
 */

/** A proxy call that failed: the respondent's page shows a generic "could not load", never what the upstream said. */
export class RemoteFailed extends Error {
  readonly status: number;
  constructor(status: number) {
    super('The lookup could not be answered.');
    this.status = status;
    this.name = 'RemoteFailed';
  }
}

const rowsSchema = z.object({
  rows: z.array(z.object({ label: z.string(), cells: z.record(z.string(), z.string()) })),
  truncated: z.boolean(),
});
const optionsSchema = z.object({ options: z.array(z.object({ id: z.string(), label: z.unknown(), code: z.string().optional() }).passthrough()) });
const checkSchema = z.object({ ok: z.boolean() });

export interface ProxyScope {
  slug: string;
  /** The version the page was loaded with: the server answers from THAT version's stored configuration. */
  versionId: string;
  /** The access token of an unlock, read at call time (it is kept in memory only). */
  token: () => string | null;
}

/** The respondent's source: ids and typed values only, anonymous (no cookie), with the form's access token when it has one. */
export function proxySource(scope: ProxyScope): RemoteSource {
  const call = async <T>(tail: string, body: Record<string, unknown>, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    const token = scope.token();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/v1/p/${encodeURIComponent(scope.slug)}${tail}`, {
        method: 'POST',
        credentials: 'omit',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(token ? { 'x-fr-access': token } : {}) },
        body: JSON.stringify({ formVersionId: scope.versionId, ...body }),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new RemoteFailed(0);
    }
    if (!res.ok) throw new RemoteFailed(res.status);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new RemoteFailed(res.status);
    return parsed.data;
  };
  return {
    lookup: (lookupId, q, signal) => call(`/lookups/${encodeURIComponent(lookupId)}`, { q }, rowsSchema, signal),
    options: async (blockId, signal) => {
      const out = await call(`/fields/${encodeURIComponent(blockId)}/options`, {}, optionsSchema, signal);
      return out.options as unknown as ChoiceOption[];
    },
    check: (blockId, value, signal) => call(`/fields/${encodeURIComponent(blockId)}/check`, { value }, checkSchema, signal),
  };
}

/** What the author's test route needs of a request: the same keys the route accepts, nothing else (an unknown key is a 400). */
export type RemoteTestRequest = Pick<ApiRequestConfig, 'url' | 'method' | 'query' | 'body' | 'parser'> & {
  credentialRef?: { secretId: string } | undefined;
  searchParam?: string | undefined;
};

export function testRequestOf(config: RemoteTestRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { url: config.url };
  if (config.method) out.method = config.method;
  if (config.query?.length) out.query = config.query;
  if (config.body?.length) out.body = config.body;
  if (config.parser) out.parser = config.parser;
  if (config.credentialRef) out.credentialRef = { secretId: config.credentialRef.secretId };
  if (config.searchParam) out.searchParam = config.searchParam;
  return out;
}

const testSchema = z.object({ status: z.number(), data: z.unknown(), truncated: z.boolean() });
export type RemoteTestResult = z.infer<typeof testSchema>;

/** One call of the author's API through the server (`forms.edit`). Any non-200 (an unreachable API, a 502, a 404 for an unsaved form) throws `RemoteFailed`. */
export async function testRemote(
  org: string,
  formId: string,
  request: RemoteTestRequest,
  extra: { q?: string; fieldKey?: string; value?: string | number | boolean; purpose?: 'test' | 'preview' } = {},
): Promise<RemoteTestResult> {
  const body: Record<string, unknown> = { request: testRequestOf(request) };
  if (extra.purpose === 'preview') body.purpose = 'preview';
  if (extra.q !== undefined) body.q = extra.q;
  if (extra.fieldKey !== undefined && extra.value !== undefined) {
    body.fieldKey = extra.fieldKey;
    body.value = extra.value;
  }
  const reply = await orgCall(org, 'POST', `/v1/forms/${encodeURIComponent(formId)}/remote/test`, body);
  if (!reply.ok) throw new RemoteFailed(reply.status);
  const parsed = testSchema.safeParse(reply.json);
  if (!parsed.success) throw new RemoteFailed(reply.status);
  return parsed.data;
}

/* ---- the org's API credentials ---- */

const credentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['bearer', 'api_key', 'basic']),
  header: z.string().nullable(),
  host: z.string(),
  last4: z.string(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
});
/** A credential as the API shows it: never with the secret. */
export type ApiCredential = z.infer<typeof credentialSchema>;

export interface NewCredential {
  name: string;
  host: string;
  /** Sent once and sealed by the server. */
  auth: ApiAuth;
}
export interface CredentialChange {
  name?: string | undefined;
  host?: string | undefined;
  auth?: ApiAuth | undefined;
}

function read<T>(reply: Reply, schema: z.ZodType<T>): T {
  if (!reply.ok) throw problemOf(reply);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ApiUnreachable();
  return parsed.data;
}

const one = (id: string) => `/v1/org/api-credentials/${encodeURIComponent(id)}`;

/** The org's credentials (public columns only), for a form's credential picker and the credentials page. */
export async function listApiCredentials(org: string): Promise<ApiCredential[]> {
  return read(await orgCall(org, 'GET', '/v1/org/api-credentials'), z.object({ items: z.array(credentialSchema) })).items;
}

export async function addApiCredential(org: string, credential: NewCredential): Promise<ApiCredential> {
  return read(await orgCall(org, 'POST', '/v1/org/api-credentials', credential), credentialSchema);
}

/** Changes a credential; sending `auth` rotates the secret. */
export async function changeApiCredential(org: string, id: string, change: CredentialChange): Promise<ApiCredential> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(change)) if (value !== undefined) body[key] = value;
  return read(await orgCall(org, 'PUT', one(id), body), credentialSchema);
}

export async function deleteApiCredential(org: string, id: string): Promise<void> {
  const reply = await orgCall(org, 'DELETE', one(id));
  if (!reply.ok) throw problemOf(reply);
}

/** Whether the member's role in `org` carries `org.settings` (the permission to add, rotate and delete credentials). */
export async function canManageApiCredentials(org: string): Promise<boolean> {
  return read(await orgCall(org, 'GET', '/v1/org'), z.object({ permissions: z.array(z.string()) })).permissions.includes('org.settings');
}
