import type { ApiRequestConfig } from '@form/schema';

/** The WHATWG URL every runtime has (this package's tsconfig carries no DOM or Node lib). */
declare const URL: new (url: string) => { searchParams: { set(key: string, value: string): void }; toString(): string };

/**
 * The upstream request, described without sending it. Pure: the API proxy and the author route build it from the stored
 * config plus one respondent value (`q` of a lookup via `searchParam`, or a field's value via its key). It never carries
 * credentials: the proxy attaches the org credential itself (host-bound, https only); a legacy inline `auth` is ignored.
 */
export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** POST only: a JSON body. */
  body?: string;
}

export function buildUpstreamRequest(config: ApiRequestConfig, extra?: { key: string; value: unknown }): UpstreamRequest {
  const method = config.method ?? 'POST';
  const accept = (config.parser ?? 'json') === 'xml' ? 'application/xml, text/xml, application/json' : 'application/json';
  const url = new URL(config.url);
  for (const pair of config.query ?? []) if (pair.key) url.searchParams.set(pair.key, pair.value);
  const headers: Record<string, string> = { Accept: accept };
  if (method === 'GET') {
    if (extra?.key) url.searchParams.set(extra.key, extra.value == null ? '' : String(extra.value));
    return { url: url.toString(), method: 'GET', headers };
  }
  const body: Record<string, unknown> = {};
  for (const pair of config.body ?? []) if (pair.key) body[pair.key] = pair.value;
  if (extra?.key) body[extra.key] = extra.value;
  headers['Content-Type'] = 'application/json';
  return { url: url.toString(), method: 'POST', headers, body: JSON.stringify(body) };
}
