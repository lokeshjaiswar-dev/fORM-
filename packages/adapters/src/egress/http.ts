import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPortError, PortError, type EgressGuard } from '@form/ports';

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  /** Larger responses are cut off with PortError('unavailable'). Default 1 MiB. */
  maxResponseBytes?: number;
  /** PEM CA bundle for an https endpoint with a private CA (Vault, an internal SIEM). */
  ca?: string;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  text(): string;
  json(): unknown;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * One HTTP(S) request. With `pinnedIp` the connection goes to that address while TLS still verifies the
 * certificate for the URL's host, so a DNS answer that changed since the egress check cannot redirect it.
 * Redirects are never followed. Network failures and timeouts → PortError('unavailable').
 */
export function sendHttp(url: URL, r: HttpRequest = {}, pinnedIp?: string): Promise<HttpResponse> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new PortError('invalid_argument', `not an http(s) URL: ${url.protocol}`));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const lookup: LookupFunction | undefined =
    pinnedIp === undefined
      ? undefined
      : (_host, options, cb) => {
          const family = isIP(pinnedIp);
          if (options.all) (cb as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: pinnedIp, family }]);
          else cb(null, pinnedIp, family);
        };
  const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
  const max = r.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, fail) => {
    let settled = false;
    const reject = (e: Error) => {
      if (settled) return;
      settled = true;
      fail(e instanceof PortError ? e : new PortError('unavailable', `${url.host}: ${e.message}`, { cause: e }));
    };
    const req = send(
      url,
      {
        method: r.method ?? (body ? 'POST' : 'GET'),
        headers: { ...(body ? { 'content-length': String(body.byteLength) } : {}), ...r.headers },
        timeout: r.timeoutMs ?? 10_000,
        ...(r.ca ? { ca: r.ca } : {}),
        ...(lookup ? { lookup } : {}),
      },
      (res) => {
        const parts: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > max) {
            reject(new PortError('unavailable', `response from ${url.host} exceeds ${max} bytes`));
            req.destroy();
            return;
          }
          parts.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const bytes = new Uint8Array(Buffer.concat(parts));
          const text = () => new TextDecoder().decode(bytes);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: bytes,
            text,
            json: () => {
              try {
                return JSON.parse(text()) as unknown;
              } catch (e) {
                throw new PortError('unavailable', `invalid JSON from ${url.host}`, { cause: e });
              }
            },
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      reject(new PortError('unavailable', `${url.host} timed out`));
      req.destroy();
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** `sendHttp` to a destination outside the platform: checked by the egress guard first, then pinned to the address it vetted. */
export async function egressHttp(guard: EgressGuard, url: URL, r: HttpRequest = {}): Promise<HttpResponse> {
  const { pinnedIp } = await guard.assertAllowed(url);
  return sendHttp(url, r, pinnedIp);
}

/**
 * A `lookup` for HTTP agents of clients that cannot call `egressHttp` themselves (the AWS SDK): every connection to a
 * host name first passes the egress guard, then goes to the address it vetted. Node skips `lookup` for IP literals,
 * so a client with a literal endpoint also checks it with `assertEndpoint`.
 */
export function egressLookup(guard: EgressGuard, protocol: 'https:' | 'http:', port = ''): LookupFunction {
  return (hostname, options, cb) => {
    guard.assertAllowed({ href: `${protocol}//${hostname}${port ? `:${port}` : ''}/`, protocol, hostname, port }).then(
      ({ pinnedIp }) => {
        const family = isIP(pinnedIp);
        if (options.all) (cb as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: pinnedIp, family }]);
        else cb(null, pinnedIp, family);
      },
      (err: unknown) => cb(err as NodeJS.ErrnoException, '', 0),
    );
  };
}

/**
 * Checks a configured endpoint before an SDK client connects to it. A pass is kept; a refusal is not, so the next call
 * checks again. A name the resolver could not answer for (a DNS blip at boot) is PortError('unavailable'), which the
 * caller's retries cover, not a lasting egress denial.
 */
export function assertEndpoint(guard: EgressGuard, url: URL): () => Promise<void> {
  let passed: Promise<void> | undefined;
  return () =>
    (passed ??= guard.assertAllowed(url).then(
      () => undefined,
      (e: unknown) => {
        passed = undefined;
        // The guard keeps the resolver's own error as the cause; a policy refusal has none.
        if (isPortError(e, 'egress_denied') && e.cause !== undefined) throw new PortError('unavailable', `${url.hostname} did not resolve`, { cause: e });
        throw e;
      },
    ));
}
