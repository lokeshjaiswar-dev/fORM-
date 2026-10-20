import { createServer as createHttpServer } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import type { AuditCheckpoint, AuditSink, IsoInstant } from '@form/ports';
import { expectPortError, useSubject, type ContractSetup, type ContractSubject } from './contract.ts';
import type { TestPki } from './test-pki.ts';

export interface AuditSinkContractSubject extends ContractSubject<AuditSink> {
  /** Everything the receiving end holds so far, as checkpoints. */
  received(): Promise<AuditCheckpoint[]>;
  /** The same sink with its receiver down; omit when there is none to take down. */
  unreachable?: () => AuditSink;
}

const ORG = '0190f1d2-0000-7000-8000-000000000001';

export function auditCheckpointFixture(seq: number, orgKey = ORG): AuditCheckpoint {
  return {
    orgKey,
    seq,
    hash: seq.toString(16).padStart(64, '0'),
    signedAt: new Date(Date.UTC(2026, 9, 19, 10, 0, seq % 60)).toISOString() as IsoInstant,
    keyId: 'audit-v1',
    alg: 'ed25519',
    signature: Buffer.alloc(64, seq % 256).toString('base64url'),
  };
}

/** What every checkpoint anchor does (architecture §2.7): delivers the checkpoint intact, refuses junk, never fails silently. */
export function runAuditSinkContract(label: string, setup: ContractSetup<AuditSinkContractSubject>): void {
  describe(`AuditSink contract: ${label}`, () => {
    const subject = useSubject(setup);
    const sink = () => subject().impl;
    const find = async (cp: AuditCheckpoint) => (await subject().received()).filter((r) => r.orgKey === cp.orgKey && r.seq === cp.seq);

    it('declares its kind', () => {
      expect(['worm_bucket', 'syslog', 'otlp']).toContain(sink().kind);
    });

    it('delivers a checkpoint intact', async () => {
      const cp = auditCheckpointFixture(41);
      await sink().forward(cp);
      expect(await find(cp)).toEqual([cp]);
    });

    it('delivers the checkpoints of several chains', async () => {
      const a = auditCheckpointFixture(7, '00000000-0000-0000-0000-000000000000');
      const b = auditCheckpointFixture(8, '0190f1d2-0000-7000-8000-000000000002');
      await sink().forward(a);
      await sink().forward(b);
      expect(await find(a)).toEqual([a]);
      expect(await find(b)).toEqual([b]);
    });

    it.each<[string, Partial<AuditCheckpoint>]>([
      ['a short hash', { hash: 'abcd' }],
      ['an upper-case hash', { hash: 'AB'.repeat(32) }],
      ['seq 0', { seq: 0 }],
      ['a fractional seq', { seq: 1.5 }],
      ['an org key that is not a uuid', { orgKey: 'org-1' }],
      ['an unknown algorithm', { alg: 'rsa' as AuditCheckpoint['alg'] }],
      ['a signature that is not base64url', { signature: 'a+b/c=' }],
      ['a key id with control characters', { keyId: 'audit\nv1' }],
    ])('refuses %s without sending anything', async (_name, patch) => {
      const cp = { ...auditCheckpointFixture(500), ...patch };
      const before = (await subject().received()).length;
      await expectPortError(sink().forward(cp), 'invalid_argument');
      expect((await subject().received()).length).toBe(before);
    });

    it("reports a receiver that is down as 'unavailable'", async (ctx) => {
      const down = subject().unreachable;
      if (!down) return ctx.skip();
      await expectPortError(down().forward(auditCheckpointFixture(9)), 'unavailable');
    });
  });
}

export interface Receiver {
  /** `tcp://` / `tls://` URL (syslog) or `http://` base URL (OTLP). */
  url: string;
  received(): Promise<AuditCheckpoint[]>;
  close(): Promise<void>;
}

/** An RFC 5425/6587 receiver (octet-counted frames) over TCP, or TLS with a private CA; the MSG is the checkpoint JSON. */
export async function startSyslogReceiver(o: { tls?: TestPki } = {}): Promise<Receiver> {
  const got: AuditCheckpoint[] = [];
  const sockets = new Set<net.Socket>();
  const onSocket = (socket: net.Socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const sp = buf.indexOf(0x20);
        if (sp < 0) return;
        const len = Number(buf.subarray(0, sp).toString('ascii'));
        if (buf.length < sp + 1 + len) return;
        const msg = buf.subarray(sp + 1, sp + 1 + len).toString('utf8');
        got.push(JSON.parse(msg.slice(msg.indexOf('{'))) as AuditCheckpoint);
        buf = buf.subarray(sp + 1 + len);
      }
    });
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  };
  const server = o.tls ? tls.createServer({ key: o.tls.serverKey, cert: o.tls.serverCert }, onSocket) : net.createServer(onSocket);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${o.tls ? 'tls' : 'tcp'}://127.0.0.1:${port}`,
    received: async () => [...got],
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

interface OtlpLogRecord {
  eventName?: string;
  body?: { stringValue?: string };
}

/** An OTLP/HTTP logs receiver (`POST /v1/logs`, JSON encoding), as an OpenTelemetry Collector in front of a SIEM. */
export async function startOtlpLogReceiver(o: { requireHeader?: [string, string] } = {}): Promise<Receiver & { readonly requests: number }> {
  const got: AuditCheckpoint[] = [];
  let requests = 0;
  const server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      requests += 1;
      const [h, v] = o.requireHeader ?? [];
      if (req.method !== 'POST' || req.url !== '/v1/logs' || req.headers['content-type'] !== 'application/json' || (h && req.headers[h] !== v)) {
        res.writeHead(h && req.headers[h] !== v ? 401 : 400).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { resourceLogs?: { scopeLogs?: { logRecords?: OtlpLogRecord[] }[] }[] };
      for (const rl of body.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          for (const r of sl.logRecords ?? []) if (r.eventName === 'fr.audit.checkpoint' && r.body?.stringValue) got.push(JSON.parse(r.body.stringValue) as AuditCheckpoint);
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    received: async () => [...got],
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
