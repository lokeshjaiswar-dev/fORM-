import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPortError, runEgressGuardContract } from '@form/testkit';
import { classifyAddress, createEgressGuard } from './guard.ts';
import { createInfrastructureEgressGuard, infrastructureHosts } from './trusted.ts';
import { assertEndpoint, egressHttp, sendHttp } from './http.ts';

runEgressGuardContract('createEgressGuard', ({ resolve, allowlist }) => ({
  impl: {
    open: createEgressGuard({ policy: 'open', allowlist, resolve }),
    allowlist: createEgressGuard({ policy: 'allowlist', allowlist, resolve }),
    none: createEgressGuard({ policy: 'none', allowlist, resolve }),
  },
}));

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['2a00:1450:4001::200e', 'public'],
    ['10.1.2.3', 'non_public'],
    ['::ffff:192.168.0.1', 'non_public'],
    ['64:ff9b::a00:1', 'non_public'],
    ['2002:a00:1::', 'non_public'],
    ['fe80::1', 'never'],
    ['::', 'never'],
    ['255.255.255.255', 'never'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('egress guard', () => {
  it('refuses malformed allowlist entries', () => {
    expect(() => createEgressGuard({ policy: 'allowlist', allowlist: ['bad host:1:2'] })).toThrow(/invalid egress allowlist entry/);
  });

  it('lets trusted infrastructure endpoints through, but never a public answer under none', async () => {
    const resolve = async (h: string) => [{ address: h === 'kms.corp.local' ? '10.1.2.3' : h === 'vault.leaky.local' ? '93.184.215.14' : '127.0.0.1', family: 4 as const }];
    const open = createEgressGuard({ policy: 'open', trusted: ['kms.corp.local', 'localhost:1025'], resolve });
    expect(await open.assertAllowed(new URL('https://kms.corp.local/'))).toEqual({ pinnedIp: '10.1.2.3' });
    expect(await open.assertAllowed(new URL('smtp://localhost:1025'))).toEqual({ pinnedIp: '127.0.0.1' });
    await expectPortError(open.assertAllowed(new URL('smtp://localhost:2525')), 'egress_denied');
    const none = createEgressGuard({ policy: 'none', trusted: ['kms.corp.local', 'vault.leaky.local'], resolve });
    expect(await none.assertAllowed(new URL('https://kms.corp.local/'))).toEqual({ pinnedIp: '10.1.2.3' });
    await expectPortError(none.assertAllowed(new URL('https://vault.leaky.local/')), 'egress_denied');
    await expectPortError(none.assertAllowed(new URL('https://other.corp.local/')), 'egress_denied');
  });

  it('honours a narrower protocol list', async () => {
    const guard = createEgressGuard({ policy: 'open', protocols: ['https:'], resolve: async () => [{ address: '93.184.215.14', family: 4 }] });
    await expectPortError(guard.assertAllowed(new URL('http://public.example.test/')), 'egress_denied');
  });
});

describe('configured endpoints', () => {
  it('retries a name that failed to resolve, as unavailable, and keeps only a pass', async () => {
    let lookups = 0;
    let dnsUp = false;
    const guard = createEgressGuard({
      policy: 'none',
      trusted: ['kms.corp.local'],
      resolve: async () => {
        lookups += 1;
        if (!dnsUp) throw Object.assign(new Error('getaddrinfo EAI_AGAIN kms.corp.local'), { code: 'EAI_AGAIN' });
        return [{ address: '10.0.0.5', family: 4 }];
      },
    });
    const ready = assertEndpoint(guard, new URL('https://kms.corp.local/'));
    await expectPortError(ready(), 'unavailable');
    dnsUp = true;
    await ready();
    await ready();
    expect(lookups).toBe(2);
  });

  it('refuses an endpoint the policy denies on every call', async () => {
    const ready = assertEndpoint(createEgressGuard({ policy: 'none', allowlist: [] }), new URL('https://10.0.0.5/'));
    await expectPortError(ready(), 'egress_denied');
    await expectPortError(ready(), 'egress_denied');
  });
});

describe('infrastructure hosts', () => {
  const vault = {
    driver: 'vault',
    address: 'https://vault.corp.local:8200',
    mount: 'transit',
    key: 'k',
    auth: { kind: 'token', tokenFile: '/t' },
    caFile: undefined,
    namespace: undefined,
    signing: { mode: 'app', seedFile: '/s' },
  } as const;

  it('trust the configured KMS, store and URLs, or the regional AWS endpoints', () => {
    expect(
      infrastructureHosts({
        kms: { driver: 'aws', region: 'ap-south-1', keyId: 'alias/k', endpoint: undefined, signing: { mode: 'app', seedFile: '/s' } },
        storage: {
          driver: 's3',
          region: 'ap-south-1',
          endpoint: undefined,
          forcePathStyle: false,
          publicEndpoint: undefined,
          credentials: undefined,
          buckets: { staging: 'a-staging', uploads: 'a-uploads', assets: 'a-assets', exports: 'a-exports', audit: 'a-audit', packs: 'a-packs' },
          sse: undefined,
        },
        urls: ['tls://SIEM.corp.local:6514', undefined, 'not a url'],
      }),
    ).toEqual([
      'kms.ap-south-1.amazonaws.com:443',
      's3.ap-south-1.amazonaws.com:443',
      ...['staging', 'uploads', 'assets', 'exports', 'audit', 'packs'].map((b) => `a-${b}.s3.ap-south-1.amazonaws.com:443`),
      'siem.corp.local:6514',
    ]);
    expect(infrastructureHosts({ kms: vault })).toEqual(['vault.corp.local:8200']);
    expect(infrastructureHosts({ urls: ['smtp://Relay.corp.local', 'smtps://relay.corp.local', 'http://[fd00::5]', 'udp://siem.corp.local'] })).toEqual([
      'relay.corp.local:25',
      'relay.corp.local:465',
      '[fd00::5]:80',
    ]);
  });

  it('trust a configured endpoint on its port only', async () => {
    const resolve = async () => [{ address: '10.0.0.5', family: 4 as const }];
    const guard = createInfrastructureEgressGuard({ egressPolicy: 'allowlist', egressAllowlist: [] }, infrastructureHosts({ kms: vault }), resolve);
    await expect(guard.assertAllowed(new URL('https://vault.corp.local:8200/v1/transit'))).resolves.toBeDefined();
    await expectPortError(guard.assertAllowed(new URL('https://vault.corp.local:22/')), 'egress_denied');
    await expectPortError(guard.assertAllowed(new URL('https://vault.corp.local/')), 'egress_denied');
  });
});

describe('pinned HTTP', () => {
  let server: Server;
  let port: number;
  const seen: IncomingMessage[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req);
      req.resume();
      if (req.url === '/big') res.end('x'.repeat(2048));
      else res.end(JSON.stringify({ host: req.headers.host }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('connects to the vetted address while keeping the host name', async () => {
    const guard = createEgressGuard({ policy: 'allowlist', allowlist: [`hooks.acme.test:${port}`], resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const res = await egressHttp(guard, new URL(`http://hooks.acme.test:${port}/x`), { method: 'POST', body: 'a=1' });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ host: `hooks.acme.test:${port}` });
  });

  it('never sends a denied request', async () => {
    const guard = createEgressGuard({ policy: 'none', allowlist: [], resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const before = seen.length;
    await expectPortError(egressHttp(guard, new URL(`http://hooks.acme.test:${port}/x`)), 'egress_denied');
    expect(seen.length).toBe(before);
  });

  it('caps the response size and maps failures to unavailable', async () => {
    await expectPortError(sendHttp(new URL(`http://127.0.0.1:${port}/big`), { maxResponseBytes: 1024 }), 'unavailable');
    await expectPortError(sendHttp(new URL('http://127.0.0.1:1/')), 'unavailable');
    await expectPortError(sendHttp(new URL('ftp://127.0.0.1/')), 'invalid_argument');
  });
});
