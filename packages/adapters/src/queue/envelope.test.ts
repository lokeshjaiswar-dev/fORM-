import { randomBytes, randomUUID } from 'node:crypto';
import { isPortError, type JobRequest } from '@form/ports';
import { describe, expect, it } from 'vitest';
import { canonicalJson, parseJobKeyring, signJob, verifyJob, type JobKeyring } from './envelope.ts';

const secret = () => randomBytes(32).toString('base64url');
const keyring = parseJobKeyring(`k2:${secret()}, k1:${secret()}`);
const orgId = randomUUID();
const reindex: JobRequest<'search.reindex'> = { orgId, resource: { type: 'form', id: randomUUID() }, data: { formId: 'f', reason: 'bulk_import' } };

describe('parseJobKeyring', () => {
  it('signs with the first key and verifies with all', () => {
    expect(keyring.current).toBe('k2');
    expect([...keyring.keys.keys()]).toEqual(['k2', 'k1']);
  });

  it.each([
    ['', /at least one key/],
    ['nokey', /id:base64url/],
    [`bad id:${secret()}`, /id:base64url/],
    ['k1:c2hvcnQ', /at least 32 bytes/],
    ['k1:not base64!', /not base64url/],
    [`k1:${secret()},k1:${secret()}`, /duplicate/],
  ])('refuses %j', (value, message) => {
    expect(() => parseJobKeyring(value)).toThrow(message);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level, drops undefined members and keeps arrays in order', () => {
    expect(canonicalJson({ b: [3, { y: 1, x: null }], a: 'é', c: undefined, d: true })).toBe('{"a":"é","b":[3,{"x":null,"y":1}],"d":true}');
    expect(canonicalJson([undefined, 1.5])).toBe('[null,1.5]');
  });

  it('refuses values that do not survive JSON', () => {
    for (const v of [Number.NaN, Infinity, 1n, new Date(0), () => 1]) {
      const err = (() => {
        try {
          canonicalJson({ v });
        } catch (e) {
          return e;
        }
      })();
      expect(isPortError(err, 'invalid_argument'), String(v)).toBe(true);
    }
  });
});

describe('signJob / verifyJob', () => {
  it('round-trips, also after a JSON round trip that reorders keys', () => {
    const envelope = signJob(keyring, 'search.reindex', reindex);
    expect(envelope).toMatchObject({ v: 1, orgId, resource: reindex.resource, data: reindex.data, sig: expect.stringMatching(/^k2\./) });
    const stored = JSON.parse(JSON.stringify({ sig: envelope.sig, data: { reason: 'bulk_import', formId: 'f' }, resource: envelope.resource, orgId, v: 1 }));
    expect(verifyJob(keyring, 'search.reindex', stored)).toEqual({ ok: true, envelope });
  });

  it('verifies envelopes signed with an older key of the ring', () => {
    const old: JobKeyring = { current: 'k1', keys: keyring.keys };
    expect(verifyJob(keyring, 'search.reindex', signJob(old, 'search.reindex', reindex)).ok).toBe(true);
  });

  it('rejects a changed org, resource, data or queue', () => {
    const envelope = signJob(keyring, 'search.reindex', reindex);
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, orgId: randomUUID() })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, resource: { type: 'form', id: randomUUID() } })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, data: { ...envelope.data, reason: 'sensitivity_change' } })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'export.build', { ...envelope, data: { exportId: 'f' } })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'file.inspect', envelope)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects other keys, forged and truncated signatures', () => {
    const envelope = signJob(keyring, 'search.reindex', reindex);
    const stranger = parseJobKeyring(`k2:${secret()}`);
    expect(verifyJob(stranger, 'search.reindex', envelope)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, sig: envelope.sig.replace(/^k2/, 'k9') })).toEqual({ ok: false, reason: 'unknown_key' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, sig: 'nodot' })).toEqual({ ok: false, reason: 'unknown_key' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, sig: envelope.sig.slice(0, -4) })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyJob(keyring, 'search.reindex', { ...envelope, sig: 'k2.!!' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects malformed envelopes without throwing', () => {
    const envelope = signJob(keyring, 'search.reindex', reindex);
    for (const bad of [
      null,
      'x',
      [],
      { ...envelope, extra: 1 },
      { ...envelope, v: 2 },
      { ...envelope, orgId: 'not-a-uuid' },
      { ...envelope, resource: { type: 'form' } },
      { ...envelope, resource: { type: 'Form!', id: 'x' } },
      { ...envelope, data: [] },
      { ...envelope, sig: 5 },
    ]) {
      expect(verifyJob(keyring, 'search.reindex', bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('enforces the scope of the queue', () => {
    const tick = signJob(keyring, 'partitions.maintain', { orgId: null, resource: { type: 'system', id: 'partitions.maintain' }, data: {} });
    expect(verifyJob(keyring, 'partitions.maintain', tick).ok).toBe(true);
    expect(verifyJob(keyring, 'partitions.maintain', { ...tick, orgId })).toEqual({ ok: false, reason: 'scope_mismatch' });
    expect(verifyJob(keyring, 'search.reindex', { ...signJob(keyring, 'search.reindex', reindex), orgId: null })).toEqual({ ok: false, reason: 'scope_mismatch' });
    expect(verifyJob(keyring, 'system.heartbeat', signJob(keyring, 'system.heartbeat', { orgId, resource: { type: 'org', id: orgId }, data: {} })).ok).toBe(true);
    expect(() => signJob(keyring, 'partitions.maintain', { orgId: orgId as never, resource: { type: 'system', id: 'x' }, data: {} })).toThrow(/must be null/);
    expect(() => signJob(keyring, 'search.reindex', { ...reindex, orgId: null as never })).toThrow(/is required/);
    expect(() => signJob(keyring, 'search.reindex', { ...reindex, orgId: 'org-1' })).toThrow(/uuid/);
    expect(() => signJob(keyring, 'search.reindex', { ...reindex, resource: { type: 'form', id: '' } })).toThrow(/resource/);
    expect(() => signJob(keyring, 'nope' as 'search.reindex', reindex)).toThrow(/unknown queue/);
  });
});
