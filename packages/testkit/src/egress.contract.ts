import { describe, expect, it } from 'vitest';
import type { EgressGuard } from '@form/ports';
import { expectPortError, useSubject, type ContractSubject } from './contract.ts';

/** What the fixture resolver answers; `rebind.example.test` answers its second address from the second lookup on. */
const ANSWERS: Record<string, string[]> = {
  'public.example.test': ['93.184.215.14'],
  'public6.example.test': ['2606:4700::6810:84e5'],
  'private.example.test': ['10.0.0.5'],
  'loopback.example.test': ['127.0.0.1'],
  'metadata.example.test': ['169.254.169.254'],
  'mixed.example.test': ['93.184.215.14', '10.0.0.5'],
  'mapped.example.test': ['::ffff:10.0.0.5'],
  'internal.acme.test': ['10.20.0.7'],
  'hooks.acme.test': ['10.20.0.8'],
  'leaky.acme.test': ['93.184.215.14'],
  'metadata.acme.test': ['169.254.169.254'],
};

/** `EGRESS_ALLOWLIST` of the allowlist and none cases. */
export const EGRESS_FIXTURE_ALLOWLIST = ['internal.acme.test', 'hooks.acme.test:8443', 'leaky.acme.test', 'metadata.acme.test', 'private.example.test'];

export interface EgressFixture {
  resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }[]>;
  allowlist: readonly string[];
}

export interface EgressGuards {
  open: EgressGuard;
  allowlist: EgressGuard;
  none: EgressGuard;
}

/**
 * The setup builds one guard per `EGRESS_POLICY`, each with the fixture's resolver and allowlist. The cases check what
 * architecture §6 asks of each policy: public internet only, the allowlist only, internal allowlisted hosts only.
 */
export function runEgressGuardContract(label: string, setup: (fixture: EgressFixture) => ContractSubject<EgressGuards> | Promise<ContractSubject<EgressGuards>>): void {
  describe(`EgressGuard contract: ${label}`, () => {
    const lookups = new Map<string, number>();
    const fixture: EgressFixture = {
      allowlist: EGRESS_FIXTURE_ALLOWLIST,
      async resolve(hostname) {
        const n = (lookups.get(hostname) ?? 0) + 1;
        lookups.set(hostname, n);
        if (hostname === 'rebind.example.test') return [{ address: n === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }];
        const answer = ANSWERS[hostname];
        if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
        return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
    };
    const subject = useSubject(() => setup(fixture));
    const guard = (p: keyof EgressGuards) => subject().impl[p];
    const at = (u: string) => new URL(u);

    describe('open', () => {
      it('reaches public hosts and pins the address it vetted', async () => {
        expect(await guard('open').assertAllowed(at('https://public.example.test/hook'))).toEqual({ pinnedIp: '93.184.215.14' });
        expect(await guard('open').assertAllowed(at('https://public6.example.test/'))).toEqual({ pinnedIp: '2606:4700::6810:84e5' });
        expect(await guard('open').assertAllowed(at('https://93.184.215.14:8443/'))).toEqual({ pinnedIp: '93.184.215.14' });
      });

      it.each(['private', 'loopback', 'metadata', 'mixed', 'mapped'])('denies a name resolving to a %s address', async (name) => {
        await expectPortError(guard('open').assertAllowed(at(`https://${name}.example.test/`)), 'egress_denied');
      });

      it.each([
        'http://10.0.0.1/',
        'http://127.0.0.1:8080/',
        'http://[::1]/',
        'http://[fd00::1]/',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:a00:1]/',
        'http://0.0.0.0/',
        'http://100.64.0.1/',
        'http://192.168.1.1/',
        'http://172.16.0.1/',
        'http://224.0.0.1/',
      ])('denies the literal %s', async (u) => {
        await expectPortError(guard('open').assertAllowed(at(u)), 'egress_denied');
      });

      it.each(['file:///etc/passwd', 'ftp://public.example.test/', 'gopher://public.example.test/', 'ws://public.example.test/'])('denies the scheme of %s', async (u) => {
        await expectPortError(guard('open').assertAllowed(at(u)), 'egress_denied');
      });

      it('denies a name that does not resolve', async () => {
        await expectPortError(guard('open').assertAllowed(at('https://nowhere.example.test/')), 'egress_denied');
      });

      it('resolves once, so a rebinding answer cannot redirect the request', async () => {
        const before = lookups.get('rebind.example.test') ?? 0;
        expect(await guard('open').assertAllowed(at('https://rebind.example.test/'))).toEqual({ pinnedIp: '93.184.215.14' });
        expect(lookups.get('rebind.example.test')).toBe(before + 1);
      });

      it('ignores the allowlist: an allowlisted private host stays unreachable', async () => {
        await expectPortError(guard('open').assertAllowed(at('https://internal.acme.test/')), 'egress_denied');
      });
    });

    describe('allowlist', () => {
      it('reaches allowlisted hosts, on private addresses too', async () => {
        expect(await guard('allowlist').assertAllowed(at('https://internal.acme.test/x'))).toEqual({ pinnedIp: '10.20.0.7' });
        expect(await guard('allowlist').assertAllowed(at('smtp://INTERNAL.acme.test./'))).toEqual({ pinnedIp: '10.20.0.7' });
        expect(await guard('allowlist').assertAllowed(at('https://leaky.acme.test/'))).toEqual({ pinnedIp: '93.184.215.14' });
      });

      it('holds an allowlisted port to that port', async () => {
        expect(await guard('allowlist').assertAllowed(at('https://hooks.acme.test:8443/'))).toEqual({ pinnedIp: '10.20.0.8' });
        await expectPortError(guard('allowlist').assertAllowed(at('https://hooks.acme.test/')), 'egress_denied');
      });

      it('denies everything else, public hosts and literals included', async () => {
        await expectPortError(guard('allowlist').assertAllowed(at('https://public.example.test/')), 'egress_denied');
        await expectPortError(guard('allowlist').assertAllowed(at('https://93.184.215.14/')), 'egress_denied');
        await expectPortError(guard('allowlist').assertAllowed(at('https://evil.internal.acme.test/')), 'egress_denied');
      });

      it('never reaches link-local metadata, even when allowlisted', async () => {
        await expectPortError(guard('allowlist').assertAllowed(at('http://metadata.acme.test/')), 'egress_denied');
      });
    });

    describe('none (air-gapped)', () => {
      it('reaches allowlisted internal hosts', async () => {
        expect(await guard('none').assertAllowed(at('smtp://internal.acme.test:25/'))).toEqual({ pinnedIp: '10.20.0.7' });
      });

      it('denies an allowlisted host that resolves to a public address', async () => {
        await expectPortError(guard('none').assertAllowed(at('https://leaky.acme.test/')), 'egress_denied');
      });

      it('denies everything else without a DNS query', async () => {
        const before = lookups.get('public.example.test') ?? 0;
        await expectPortError(guard('none').assertAllowed(at('https://public.example.test/')), 'egress_denied');
        await expectPortError(guard('none').assertAllowed(at('https://93.184.215.14/')), 'egress_denied');
        await expectPortError(guard('none').assertAllowed(at('https://10.9.9.9/')), 'egress_denied');
        expect(lookups.get('public.example.test') ?? 0).toBe(before);
      });
    });
  });
}
