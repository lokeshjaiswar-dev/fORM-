import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPortError, type AuditCheckpoint } from '@form/ports';
import { createEgressGuard } from '../egress/guard.ts';
import { createSyslogAuditSink, syslogFrame } from './syslog.ts';

const egress = createEgressGuard({ policy: 'none', trusted: ['127.0.0.1'] });

const cp: AuditCheckpoint = {
  orgKey: '00000000-0000-0000-0000-000000000000',
  seq: 42,
  hash: 'ab'.repeat(32),
  signedAt: '2026-10-19T10:00:00.000Z' as AuditCheckpoint['signedAt'],
  keyId: 'audit-v1',
  alg: 'ed25519',
  signature: 'c2ln',
};

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(onData: (chunk: Buffer) => void, o: { hang?: boolean } = {}): Promise<number> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    if (o.hang) return;
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      onData(Buffer.concat(chunks));
      socket.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

describe('syslog audit sink', () => {
  it('frames an RFC 5424 message with octet counting', () => {
    const frame = syslogFrame(cp, { appName: 'form', hostname: 'worker 1', now: new Date('2026-10-19T10:00:01Z') }).toString('utf8');
    const [len, ...rest] = frame.split(' ');
    const msg = rest.join(' ');
    expect(Number(len)).toBe(Buffer.byteLength(msg));
    expect(msg).toBe(`<109>1 2026-10-19T10:00:01.000Z worker_1 form - fr.audit.checkpoint - ${JSON.stringify(cp)}`);
  });

  it('delivers a checkpoint over TCP', async () => {
    let got = '';
    const port = await listen((b) => (got = b.toString('utf8')));
    const sink = createSyslogAuditSink({ url: `tcp://127.0.0.1:${port}`, egress, hostname: 'h', now: () => new Date(0) });
    expect(sink.kind).toBe('syslog');
    await sink.forward(cp);
    expect(got).toMatch(/^\d+ <109>1 1970-01-01T00:00:00\.000Z h form - fr\.audit\.checkpoint - \{/);
    expect(JSON.parse(got.slice(got.indexOf('{')))).toEqual(cp);
  });

  it('fails as unavailable when nobody listens or the peer hangs', async () => {
    const closed = await listen(() => {});
    await new Promise((r) => servers.pop()!.close(r));
    const err = await createSyslogAuditSink({ url: `tcp://127.0.0.1:${closed}`, egress }).forward(cp).catch((e: unknown) => e);
    expect(isPortError(err, 'unavailable')).toBe(true);
    const hang = await listen(() => {}, { hang: true });
    const slow = await createSyslogAuditSink({ url: `tcp://127.0.0.1:${hang}`, egress, timeoutMs: 200 }).forward(cp).catch((e: unknown) => e);
    expect(isPortError(slow, 'unavailable')).toBe(true);
  });

  it('refuses other schemes', () => {
    expect(() => createSyslogAuditSink({ url: 'udp://127.0.0.1:514', egress })).toThrow(/tcp:\/\/ or tls:\/\//);
  });
});
