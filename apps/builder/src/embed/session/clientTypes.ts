/*
 * The shape of the DMS client the pages use. Here (no runtime imports) so `dmsClient.ts`, the legacy client and the slot that connects
 * them share it without a circle.
 */

export interface DmsClientOptions {
  /**
   * Kept for the old call shape. The session client sends only to the API base its session was exchanged with (an allowlisted build
   * value) and refuses a different one.
   */
  apiBase: string;
  /** Ignored by the session client: fORM- sends no `X-Tenant-Id` (dms-api takes the tenant from the session). Display value only. */
  tenantId: string;
  /** Ignored by the session client: fORM- sends no `X-Workspace-Id`. */
  workspaceId: string;
  /** For tests; defaults to `window.fetch`. */
  fetch?: typeof fetch;
  /**
   * @deprecated Ignored by the session client: the credential is the session's (`session/dmsSession.ts`), never a caller's. Still in
   * the type so the older tests of the repositories compile; the legacy transport (M2 build) reads it.
   */
  token?: () => string | null;
}

export interface DmsClient {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
}
