import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPortError, runKeyProviderContract, startVault, utf8, type Vault } from '@form/testkit';
import { createEgressGuard } from '../src/egress/index.ts';
import { createKmsKeyProvider, createVaultNativeSigner, createVaultRootKey, openSealedSigner, sealSigningSeed, vaultStaticToken } from '../src/kms/index.ts';

const egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1', 'localhost'] });
const CONTRACT_KEYS = ['audit-platform', 'templates-system'];

let vault: Vault;
beforeAll(async () => {
  vault = await startVault();
  await vault.transitKey('form-root');
  for (const k of CONTRACT_KEYS) await vault.transitKey(`sign-${k}`, 'ecdsa-p256');
});
afterAll(() => vault?.stop());

const opts = () => ({ egress, address: vault.address, tokens: vaultStaticToken(vault.token) });

runKeyProviderContract('Vault transit, app-held Ed25519', async () => {
  const root = createVaultRootKey({ ...opts(), key: 'form-root' });
  return { impl: createKmsKeyProvider({ root, signer: await openSealedSigner(root, await sealSigningSeed(root)) }) };
});

runKeyProviderContract('Vault transit, KMS-native ES256', () => ({
  impl: createKmsKeyProvider({
    root: createVaultRootKey({ ...opts(), key: 'form-root' }),
    signer: createVaultNativeSigner({ ...opts(), keys: Object.fromEntries(CONTRACT_KEYS.map((k) => [k, `sign-${k}`])) }),
  }),
}));

describe('Vault transit', () => {
  it('refuses a bad token as unavailable and a missing key as not found', async () => {
    const bad = createVaultRootKey({ ...opts(), tokens: vaultStaticToken('not-a-token'), key: 'form-root' });
    await expectPortError(bad.encrypt(utf8('k'), 'aad'), 'unavailable');
    await expectPortError(createVaultRootKey({ ...opts(), key: 'no-such-key' }).decrypt(utf8('vault:v1:AAAA'), 'transit/no-such-key', 'aad'), 'not_found', 'integrity');
  });

  it('refuses a native signing key of the wrong type', async () => {
    const signer = createVaultNativeSigner({ ...opts(), keys: { 'audit-v1': 'form-root' } });
    await expect(signer.publicKey('audit-v1')).rejects.toThrow(/not ecdsa-p256/);
  });
});
