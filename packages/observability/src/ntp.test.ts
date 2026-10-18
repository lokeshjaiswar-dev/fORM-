import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedClockCheck, checkClock, queryNtp } from './ntp.ts';

const NTP_UNIX_OFFSET = 2_208_988_800;

function writeTimestamp(buf: Buffer, at: number, ms: number) {
  const seconds = Math.floor(ms / 1000);
  buf.writeUInt32BE(seconds + NTP_UNIX_OFFSET, at);
  buf.writeUInt32BE(Math.floor(((ms - seconds * 1000) / 1000) * 2 ** 32), at + 4);
}

type Behaviour = { skewMs: number } | { echo: 'wrong-nonce' } | { mode: number } | 'silent';

const sockets: Socket[] = [];

async function fakeServer(behaviour: Behaviour): Promise<string> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  socket.on('message', (msg, rinfo) => {
    if (behaviour === 'silent') return;
    const reply = Buffer.alloc(48);
    reply[0] = 'mode' in behaviour ? 0x20 | behaviour.mode : 0x24;
    reply[1] = 2;
    if ('echo' in behaviour) Buffer.alloc(8, 7).copy(reply, 24);
    else msg.copy(reply, 24, 40, 48);
    const serverNow = Date.now() + ('skewMs' in behaviour ? behaviour.skewMs : 0);
    writeTimestamp(reply, 32, serverNow);
    writeTimestamp(reply, 40, serverNow);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return `127.0.0.1:${(socket.address() as AddressInfo).port}`;
}

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

describe('queryNtp', () => {
  it('measures the offset against the server clock', async () => {
    const server = await fakeServer({ skewMs: 5000 });
    const sample = await queryNtp(server);
    expect(sample.offsetMs).toBeGreaterThan(4800);
    expect(sample.offsetMs).toBeLessThan(5200);
    expect(sample.server).toBe(server);
  });

  it('ignores replies that do not echo the request nonce, then times out', async () => {
    const server = await fakeServer({ echo: 'wrong-nonce' });
    await expect(queryNtp(server, { timeoutMs: 200 })).rejects.toThrow(/timeout/);
  });

  it('ignores replies that are not in server mode', async () => {
    const server = await fakeServer({ mode: 3 });
    await expect(queryNtp(server, { timeoutMs: 200 })).rejects.toThrow(/timeout/);
  });
});

describe('checkClock', () => {
  it('is skipped without servers', async () => {
    expect(await checkClock({ servers: [], maxOffsetMs: 1000 })).toEqual({ status: 'skipped' });
  });

  it('passes within the limit and fails beyond it', async () => {
    const good = await fakeServer({ skewMs: 0 });
    const bad = await fakeServer({ skewMs: -3000 });
    expect(await checkClock({ servers: [good], maxOffsetMs: 1000 })).toMatchObject({ status: 'ok', server: good });
    const failed = await checkClock({ servers: [bad], maxOffsetMs: 1000 });
    expect(failed).toMatchObject({ status: 'failed', server: bad });
    expect(failed.status === 'failed' && failed.reason).toMatch(/exceeds 1000 ms/);
  });

  it('falls back to the next server and reports when none answers', async () => {
    const silent = await fakeServer('silent');
    const good = await fakeServer({ skewMs: 0 });
    expect(await checkClock({ servers: [silent, good], maxOffsetMs: 1000, timeoutMs: 200 })).toMatchObject({ status: 'ok', server: good });
    const none = await checkClock({ servers: [silent], maxOffsetMs: 1000, timeoutMs: 200 });
    expect(none).toMatchObject({ status: 'failed' });
    expect(none.status === 'failed' && none.reason).toMatch(/no NTP server answered/);
  });

  it('caches results for the configured time', async () => {
    const server = await fakeServer({ skewMs: 0 });
    let t = 0;
    const check = cachedClockCheck({ servers: [server], maxOffsetMs: 1000, ttlMs: 1000, now: () => t });
    const first = check();
    expect(check()).toBe(first);
    t = 1000;
    expect(check()).not.toBe(first);
    await first;
  });
});
