import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PortError, type AuditCheckpoint, type BucketName, type PutOptions, type Storage } from '@form/ports';
import {
  auditCheckpointFixture,
  collectBytes,
  createTestPki,
  expectPortError,
  runAuditSinkContract,
  startOtlpLogReceiver,
  startSyslogReceiver,
} from '@form/testkit';
import { createEgressGuard } from '../egress/guard.ts';
import { createOtlpAuditSink } from './otlp.ts';
import { createSyslogAuditSink } from './syslog.ts';
import { checkpointObjectKey, createWormBucketAuditSink } from './worm.ts';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const trusted = createEgressGuard({ policy: 'none', trusted: ['127.0.0.1'] });
/** `localhost` for the certificate name, resolved to the IPv4 loopback the receivers listen on. */
const trustedLocalhost = createEgressGuard({ policy: 'none', trusted: ['localhost'], resolve: async () => [{ address: '127.0.0.1', family: 4 }] });

/** `put`, `get` and `capabilities` of a store with Object Lock, recording the lock of every write. */
function lockedStore(objectLock: boolean): Storage & { locks: Map<string, PutOptions['objectLock']> } {
  const objects = new Map<string, Uint8Array>();
  const locks = new Map<string, PutOptions['objectLock']>();
  const k = (b: BucketName, key: string) => `${b}/${key}`;
  const nope = () => Promise.reject(new PortError('unsupported', 'not in this test store'));
  return {
    locks,
    presignPost: nope,
    presignGet: nope,
    head: nope,
    copy: nope,
    delete: nope,
    async put(bucket, key, body, o) {
      if (o.objectLock && !objectLock) throw new PortError('unsupported', 'no Object Lock');
      objects.set(k(bucket, key), body instanceof Uint8Array ? body : await collectBytes(body));
      locks.set(k(bucket, key), o.objectLock);
    },
    async get(bucket, key) {
      const body = objects.get(k(bucket, key));
      if (!body) throw new PortError('not_found', key);
      return (async function* () {
        yield body;
      })();
    },
    capabilities: async () => ({ objectLock, versioning: objectLock, sse: false }),
  };
}

runAuditSinkContract('syslog over TCP', async () => {
  const r = await startSyslogReceiver();
  const down = await closedPort();
  return {
    impl: createSyslogAuditSink({ url: r.url, egress: trusted }),
    received: r.received,
    unreachable: () => createSyslogAuditSink({ url: `tcp://127.0.0.1:${down}`, egress: trusted, timeoutMs: 1000 }),
    dispose: r.close,
  };
});

runAuditSinkContract('syslog over TLS with a private CA (RFC 5425)', async () => {
  const pki = createTestPki();
  const r = await startSyslogReceiver({ tls: pki });
  return { impl: createSyslogAuditSink({ url: r.url.replace('127.0.0.1', 'localhost'), egress: trustedLocalhost, ca: pki.caCert }), received: r.received, dispose: r.close };
});

runAuditSinkContract('OTLP/HTTP logs', async () => {
  const r = await startOtlpLogReceiver({ requireHeader: ['x-api-key', 'k1'] });
  const down = await closedPort();
  return {
    impl: createOtlpAuditSink({ url: r.url, egress: trusted, headers: { 'x-api-key': 'k1' } }),
    received: r.received,
    unreachable: () => createOtlpAuditSink({ url: `http://127.0.0.1:${down}`, egress: trusted, timeoutMs: 1000 }),
    dispose: r.close,
  };
});

runAuditSinkContract('WORM bucket', () => {
  const storage = lockedStore(true);
  return {
    impl: createWormBucketAuditSink({ storage }),
    received: async () => {
      const out: AuditCheckpoint[] = [];
      for (const key of storage.locks.keys()) {
        out.push(JSON.parse(new TextDecoder().decode(await collectBytes(await storage.get('audit', key.slice('audit/'.length))))) as AuditCheckpoint);
      }
      return out;
    },
  };
});

describe('audit sinks', () => {
  it('lock WORM checkpoints in compliance mode for the retention period, and refuse a bucket without Object Lock', async () => {
    const storage = lockedStore(true);
    const sink = createWormBucketAuditSink({ storage, retentionYears: 7, now: () => new Date('2026-10-19T10:00:00Z') });
    const cp = auditCheckpointFixture(3);
    await sink.forward(cp);
    expect(storage.locks.get(`audit/${checkpointObjectKey(cp)}`)).toEqual({ mode: 'compliance', retainUntil: new Date('2033-10-19T00:00:00Z') });
    expect(checkpointObjectKey(cp)).toBe(`checkpoints/${cp.orgKey}/00000000000000000003.json`);
    const unlocked = createWormBucketAuditSink({ storage: lockedStore(false) });
    expect(await unlocked.available()).toBe(false);
    await expectPortError(unlocked.forward(cp), 'unsupported');
  });

  it('refuse a TLS SIEM whose certificate the CA does not vouch for', async () => {
    const r = await startSyslogReceiver({ tls: createTestPki() });
    try {
      await expectPortError(createSyslogAuditSink({ url: r.url, egress: trusted, ca: createTestPki().caCert, timeoutMs: 2000 }).forward(auditCheckpointFixture(1)), 'unavailable');
      expect(await r.received()).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it('never reach a SIEM or collector the egress guard denies', async () => {
    const otlp = await startOtlpLogReceiver();
    const syslog = await startSyslogReceiver();
    try {
      const deny = createEgressGuard({ policy: 'none' });
      await expectPortError(createOtlpAuditSink({ url: otlp.url, egress: deny }).forward(auditCheckpointFixture(1)), 'egress_denied');
      await expectPortError(createSyslogAuditSink({ url: syslog.url, egress: deny }).forward(auditCheckpointFixture(1)), 'egress_denied');
      expect(otlp.requests).toBe(0);
      expect(await syslog.received()).toEqual([]);
    } finally {
      await otlp.close();
      await syslog.close();
    }
  });

  it('report an OTLP refusal as unavailable and validate their options', async () => {
    const r = await startOtlpLogReceiver({ requireHeader: ['x-api-key', 'k1'] });
    try {
      await expectPortError(createOtlpAuditSink({ url: r.url, egress: trusted }).forward(auditCheckpointFixture(1)), 'unavailable');
    } finally {
      await r.close();
    }
    expect(() => createOtlpAuditSink({ url: 'ftp://collector', egress: trusted })).toThrow(/http/);
    expect(() => createOtlpAuditSink({ url: 'http://collector', egress: trusted, headers: { 'x-key': 'a\r\nb' } })).toThrow(/header/);
  });
});
