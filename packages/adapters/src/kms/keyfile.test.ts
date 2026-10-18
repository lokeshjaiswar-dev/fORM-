import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPortError, runKeyProviderContract, utf8, verifySignature } from '@form/testkit';
import { createKeyfileKeyProvider, generateKeyfileContent, loadKeyfileKeyProvider } from './keyfile.ts';

runKeyProviderContract('local keyfile', () => ({ impl: createKeyfileKeyProvider({ masterKey: randomBytes(32) }) }));

describe('keyfile KMS', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'form-keyfile-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const org = { orgId: 'org-1' };

  it('loads base64 and raw keyfiles to the same keys', async () => {
    const content = generateKeyfileContent();
    const b64 = path.join(dir, 'b64.key');
    const raw = path.join(dir, 'raw.key');
    await writeFile(b64, content);
    await writeFile(raw, Buffer.from(content.trim(), 'base64'));
    const a = await loadKeyfileKeyProvider(b64);
    const b = await loadKeyfileKeyProvider(raw);
    const { wrapped, kekRef } = await a.wrap(utf8('0123456789abcdef0123456789abcdef'), org);
    expect(new TextDecoder().decode(await b.unwrap(wrapped, kekRef, org))).toBe('0123456789abcdef0123456789abcdef');
    expect((await b.publicKey('audit')).key).toEqual((await a.publicKey('audit')).key);
    const sig = await a.sign('audit', utf8('x'));
    expect(await verifySignature('ed25519', (await b.publicKey('audit')).key, sig.signature, utf8('x'))).toBe(true);
  });

  it('rejects malformed keyfiles', async () => {
    const short = path.join(dir, 'short.key');
    await writeFile(short, 'c2hvcnQ=');
    await expect(loadKeyfileKeyProvider(short)).rejects.toThrow(/32 raw bytes/);
    expect(() => createKeyfileKeyProvider({ masterKey: new Uint8Array(16) })).toThrow(/32 bytes/);
  });

  it('cannot unwrap keys from another master key', async () => {
    const a = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
    const b = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
    const { wrapped, kekRef } = await a.wrap(randomBytes(32), org);
    await expectPortError(b.unwrap(wrapped, kekRef, org), 'not_found');
  });

  it('rejects an empty org and oversized keys', async () => {
    const k = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
    await expectPortError(k.wrap(randomBytes(32), { orgId: '' }), 'invalid_argument');
    await expectPortError(k.wrap(randomBytes(1025), org), 'invalid_argument');
    await expectPortError(k.sign('bad key id', utf8('x')), 'invalid_argument');
  });
});
