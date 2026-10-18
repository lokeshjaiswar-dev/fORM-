import { createHmac, timingSafeEqual } from 'node:crypto';
import { JOBS, PortError, type JobEnvelope, type JobName, type JobRequest, type JobResource } from '@form/ports';

/**
 * ADR-0016 job envelopes: `sig` is an HMAC-SHA256 over the canonical JSON of `{ v, queue, orgId, resource, data }`.
 * The queue name is signed too, so an envelope cannot be replayed into another queue's handler.
 */

export interface JobKeyring {
  /** Signs every new envelope. */
  current: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export type EnvelopeRejection = 'malformed' | 'scope_mismatch' | 'unknown_key' | 'bad_signature';

export type EnvelopeCheck<N extends JobName> = { ok: true; envelope: JobEnvelope<N> } | { ok: false; reason: EnvelopeRejection };

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_TYPE = /^[a-z][a-z_]{0,63}$/;
const MIN_SECRET_BYTES = 32;
const ENVELOPE_KEYS = ['data', 'orgId', 'resource', 'sig', 'v'];

const invalid = (message: string) => new PortError('invalid_argument', message);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `JOB_SIGNING_KEYS`: comma-separated `id:base64url-secret` entries, each secret at least 32 bytes. The first
 * signs; all of them verify, so a key can be rotated in without failing the jobs already queued.
 */
export function parseJobKeyring(value: string): JobKeyring {
  const keys = new Map<string, Uint8Array>();
  let current: string | undefined;
  for (const entry of value.split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
    const sep = entry.indexOf(':');
    const id = sep > 0 ? entry.slice(0, sep) : '';
    const secret = sep > 0 ? entry.slice(sep + 1) : '';
    if (!KEY_ID.test(id)) throw invalid('job signing keys: each entry is id:base64url with an id of [A-Za-z0-9_-]{1,32}');
    if (keys.has(id)) throw invalid(`job signing keys: duplicate id ${id}`);
    if (!BASE64URL.test(secret)) throw invalid(`job signing keys: ${id} is not base64url`);
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.byteLength < MIN_SECRET_BYTES) throw invalid(`job signing keys: ${id} must be at least ${MIN_SECRET_BYTES} bytes`);
    keys.set(id, new Uint8Array(bytes));
    current ??= id;
  }
  if (!current) throw invalid('job signing keys: at least one key is required');
  return { current, keys };
}

/** RFC 8785-style canonical JSON for ids-only payloads: sorted keys, no whitespace, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('canonicalJson: numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${members.join(',')}}`;
  }
  throw invalid(`canonicalJson: ${typeof value} values cannot be signed`);
}

function mac(secret: Uint8Array, name: JobName, body: { orgId: string | null; resource: JobResource; data: unknown }): Buffer {
  const signed = canonicalJson({ v: 1, queue: name, orgId: body.orgId, resource: body.resource, data: body.data });
  return createHmac('sha256', secret).update(signed).digest();
}

function scopeAllows(name: JobName, orgId: string | null): boolean {
  const scope = JOBS[name].scope;
  return scope === 'any' || (scope === 'org') === (orgId !== null);
}

function isResource(v: unknown): v is JobResource {
  return (
    isPlainObject(v) &&
    Object.keys(v).sort().join() === 'id,type' &&
    typeof v.type === 'string' &&
    RESOURCE_TYPE.test(v.type) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id.length <= 128
  );
}

export function signJob<N extends JobName>(keyring: JobKeyring, name: N, request: JobRequest<N>): JobEnvelope<N> {
  if (!(name in JOBS)) throw invalid(`unknown queue ${String(name)}`);
  const orgId = request.orgId as string | null;
  if (orgId !== null && !UUID.test(orgId)) throw invalid('orgId must be a uuid or null');
  if (!scopeAllows(name, orgId)) throw invalid(`${name} is a ${JOBS[name].scope} job; orgId ${orgId === null ? 'is required' : 'must be null'}`);
  if (!isResource(request.resource)) throw invalid('resource must be { type, id }');
  if (!isPlainObject(request.data)) throw invalid('data must be a plain object');
  const secret = keyring.keys.get(keyring.current);
  if (!secret) throw invalid(`no secret for the current key ${keyring.current}`);
  const sig = `${keyring.current}.${mac(secret, name, { orgId, resource: request.resource, data: request.data }).toString('base64url')}`;
  return { v: 1, orgId: request.orgId, resource: { type: request.resource.type, id: request.resource.id }, data: request.data, sig };
}

/** Checks shape, scope and signature of what a queue handed back. Never throws on bad input. */
export function verifyJob<N extends JobName>(keyring: JobKeyring, name: N, value: unknown): EnvelopeCheck<N> {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== ENVELOPE_KEYS.join()) return { ok: false, reason: 'malformed' };
  const { v, orgId, resource, data, sig } = value;
  if (v !== 1 || !isResource(resource) || !isPlainObject(data) || typeof sig !== 'string') return { ok: false, reason: 'malformed' };
  if (orgId !== null && (typeof orgId !== 'string' || !UUID.test(orgId))) return { ok: false, reason: 'malformed' };
  if (!scopeAllows(name, orgId)) return { ok: false, reason: 'scope_mismatch' };
  const dot = sig.indexOf('.');
  const secret = dot > 0 ? keyring.keys.get(sig.slice(0, dot)) : undefined;
  if (!secret) return { ok: false, reason: 'unknown_key' };
  const given = sig.slice(dot + 1);
  let expected: Buffer;
  try {
    expected = mac(secret, name, { orgId, resource, data });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const actual = BASE64URL.test(given) ? Buffer.from(given, 'base64url') : Buffer.alloc(0);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, envelope: { v: 1, orgId, resource, data, sig } as JobEnvelope<N> };
}
