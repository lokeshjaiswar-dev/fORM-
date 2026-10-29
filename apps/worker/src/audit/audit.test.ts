import { generateKeyPairSync, sign } from 'node:crypto';
import type { Db } from '@form/db';
import type { KeyProvider, Queue } from '@form/ports';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { auditChainRequest, startAuditChainDispatcher } from './dispatcher.ts';
import { checkpointSigner, publicKeyObject } from './signatures.ts';

const ORG = '0190f5a2-7c1e-7a00-8000-000000000001';
const statement = { orgKey: ORG, seq: 9, hash: new Uint8Array(32).fill(3), signedAt: new Date('2026-10-19T10:00:00Z') };

/** An app-held Ed25519 signing key, as the keyfile and the KMS-wrapped default provide. */
function ed25519Provider(): KeyProvider {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    wrap: vi.fn(),
    unwrap: vi.fn(),
    sign: async (_id, data) => ({ alg: 'ed25519', signature: new Uint8Array(sign(null, data, privateKey)) }),
    publicKey: async () => ({ alg: 'ed25519', key: new Uint8Array(x) }),
  };
}

/** A KMS-native ES256 key provider, as Azure Key Vault would be (WP-1.03). */
function es256Provider(): KeyProvider {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.of(4), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return {
    wrap: vi.fn(),
    unwrap: vi.fn(),
    sign: async (_id, data) => ({ alg: 'es256', signature: new Uint8Array(sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })) }),
    publicKey: async () => ({ alg: 'es256', key: new Uint8Array(raw) }),
  };
}

describe('checkpointSigner', () => {
  it('signs and verifies with the app-held Ed25519 key and with a KMS-native ES256 key', async () => {
    for (const keys of [ed25519Provider(), es256Provider()]) {
      const signer = checkpointSigner(keys, 'audit-v1');
      const cp = await signer.sign(statement);
      expect(cp).toMatchObject({ ...statement, keyId: 'audit-v1' });
      expect(await signer.verify(cp)).toBe(true);
      expect(await signer.verify({ ...cp, seq: 10 })).toBe(false);
      expect(await signer.verify({ ...cp, alg: cp.alg === 'ed25519' ? 'es256' : 'ed25519' })).toBe(false);
      expect(await signer.verify({ ...cp, signature: new Uint8Array(64) })).toBe(false);
    }
  });

  it('verifies only checkpoints of the configured and the retired audit keys', async () => {
    const keys = ed25519Provider();
    const stray = await checkpointSigner(keys, 'tenant-dek').sign(statement);
    expect(await checkpointSigner(keys, 'audit-v1').verify(stray)).toBe(false);
    expect(await checkpointSigner(keys, 'audit-v2', ['tenant-dek']).verify(stray)).toBe(true);
  });

  it('refuses malformed public keys and a provider that signs with another algorithm', async () => {
    expect(() => publicKeyObject('ed25519', new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => publicKeyObject('es256', new Uint8Array(65))).toThrow(/65-byte/);
    const liar: KeyProvider = { ...es256Provider(), publicKey: async () => ({ alg: 'ed25519', key: new Uint8Array(32).fill(9) }) };
    await expect(checkpointSigner(liar, 'k').sign(statement)).rejects.toThrow(/signed with es256/);
    const missing: KeyProvider = { ...es256Provider(), publicKey: async () => Promise.reject(new Error('no such key')) };
    expect(await checkpointSigner(missing, 'k').verify({ ...statement, keyId: 'k', alg: 'es256', signature: new Uint8Array(64) })).toBe(false);
  });
});

/** A Db whose transactions run on the same `execute` (the key listing runs inside withTenant). */
function fakeDb(execute: () => Promise<unknown>): Db {
  const db = { execute: vi.fn(execute), transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) };
  return db as unknown as Db;
}

describe('startAuditChainDispatcher', () => {
  it('sends one audit.chain job per chain with pending rows, keyed by the chain', async () => {
    const oldest = new Date(Date.now() - 1500);
    const db = fakeDb(async () => ({ rows: [{ org_key: ORG, oldest, pending: '3' }] }));
    const send = vi.fn(async () => 'id');
    const ticks: number[] = [];
    const d = startAuditChainDispatcher({ db, queue: { send } as unknown as Pick<Queue, 'send'>, log: pino({ level: 'silent' }), intervalMs: 60_000, onTick: (t) => ticks.push(t.pending) });
    await d.tick();
    await d.stop();
    expect(send).toHaveBeenCalledWith('audit.chain', auditChainRequest(ORG), { singletonKey: `audit.chain:${ORG}` });
    expect(auditChainRequest(ORG)).toEqual({ orgId: ORG, resource: { type: 'audit_chain', id: ORG }, data: {} });
    expect(ticks).toEqual([3]);
  });

  it('logs and keeps going when a pass fails', async () => {
    const db = fakeDb(async () => Promise.reject(new Error('db down')));
    const log = pino({ level: 'silent' });
    const error = vi.spyOn(log, 'error');
    const d = startAuditChainDispatcher({ db, queue: { send: vi.fn() } as unknown as Pick<Queue, 'send'>, log, intervalMs: 60_000 });
    await d.tick();
    await d.stop();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'audit chain dispatch failed');
  });
});
