import { DmsApiError, DmsAuthError, isRecord, messageOf, readAnswer } from '@/embed/dmsClient';
import type { DmsClient, DmsClientOptions } from '@/embed/session/clientTypes';
import { readDmsToken } from './cookieToken';

/*
 * The transport of the M2 legacy build (`#fp=` launches): the user's own DMS token from the cookie reader, `X-Tenant-Id` and
 * `X-Workspace-Id` from the descriptor, the legacy paths. This is exactly what `dmsClient.ts` did before run dmsplus-int. In a default
 * build this file is not part of the bundle.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export function createLegacyClient(options: DmsClientOptions): DmsClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const token = options.token ?? readDmsToken;
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const bearer = token();
      if (!bearer) throw new DmsAuthError();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(`${options.apiBase}${path}`, {
          method,
          // The token is sent as a header, never as a cookie: nothing else rides along to another origin.
          credentials: 'omit',
          // A redirect would carry the bearer to wherever the first answer points.
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${bearer}`,
            'X-Tenant-Id': options.tenantId,
            'X-Workspace-Id': options.workspaceId,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        if (controller.signal.aborted) throw new Error('DMS did not answer in time. Try again.');
        throw new Error(`DMS cannot be reached (${e instanceof Error ? e.message : String(e)}).`);
      } finally {
        clearTimeout(timer);
      }
      const parsed = await readAnswer(response);
      if (response.status === 401) throw new DmsAuthError();
      if (!response.ok) {
        const code = isRecord(parsed) && (typeof parsed.code === 'string' || typeof parsed.code === 'number') ? parsed.code : null;
        throw new DmsApiError(response.status, messageOf(parsed, response.status), code, parsed);
      }
      return parsed as T;
    },
  };
}
