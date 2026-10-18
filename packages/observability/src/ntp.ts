import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';

/** Seconds between the NTP epoch (1900) and the Unix epoch. */
const NTP_UNIX_OFFSET = 2_208_988_800;

export interface NtpSample {
  server: string;
  /** Local clock minus server clock is `-offsetMs`; a positive offset means the local clock is behind. */
  offsetMs: number;
  rttMs: number;
}

export interface NtpOptions {
  timeoutMs?: number;
  /** Local clock, for tests. */
  now?: () => number;
}

function readTimestamp(buf: Buffer, at: number): number {
  return (buf.readUInt32BE(at) - NTP_UNIX_OFFSET) * 1000 + (buf.readUInt32BE(at + 4) / 2 ** 32) * 1000;
}

function parseServer(server: string): { host: string; port: number } {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(server);
  return { host: m?.[1] ?? server, port: m?.[2] ? Number(m[2]) : 123 };
}

/** One SNTPv4 exchange (RFC 4330). The originate timestamp is a random nonce, checked on the reply. */
export function queryNtp(server: string, options: NtpOptions = {}): Promise<NtpSample> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 2000;
  const { host, port } = parseServer(server);
  const request = Buffer.alloc(48);
  request[0] = 0x23;
  const nonce = randomBytes(8);
  nonce.copy(request, 40);

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    let t1 = 0;
    const done = (err: Error | undefined, sample?: NtpSample) => {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else if (sample) resolve(sample);
    };
    const timer = setTimeout(() => done(new Error(`ntp ${server}: timeout after ${timeoutMs} ms`)), timeoutMs);
    socket.on('error', (err) => done(err));
    socket.on('message', (msg) => {
      const t4 = now();
      if (msg.length < 48) return;
      const mode = msg[0]! & 0x07;
      const stratum = msg[1]!;
      if (mode !== 4 || stratum === 0 || stratum > 15 || !msg.subarray(24, 32).equals(nonce)) return;
      const t2 = readTimestamp(msg, 32);
      const t3 = readTimestamp(msg, 40);
      done(undefined, { server, offsetMs: (t2 - t1 + (t3 - t4)) / 2, rttMs: t4 - t1 - (t3 - t2) });
    });
    t1 = now();
    socket.send(request, port, host, (err) => {
      if (err) done(err);
    });
  });
}

export type ClockStatus =
  | { status: 'skipped' }
  | { status: 'ok'; server: string; offsetMs: number }
  | { status: 'failed'; reason: string; server?: string; offsetMs?: number };

export interface ClockCheckOptions extends NtpOptions {
  servers: readonly string[];
  maxOffsetMs: number;
}

/** Asks each server in turn; the first answer decides. Boot and readiness fail above `maxOffsetMs` (architecture §7.7). */
export async function checkClock(options: ClockCheckOptions): Promise<ClockStatus> {
  if (options.servers.length === 0) return { status: 'skipped' };
  const errors: string[] = [];
  for (const server of options.servers) {
    try {
      const sample = await queryNtp(server, options);
      const offsetMs = Math.round(sample.offsetMs);
      return Math.abs(sample.offsetMs) <= options.maxOffsetMs
        ? { status: 'ok', server, offsetMs }
        : { status: 'failed', reason: `clock offset ${offsetMs} ms exceeds ${options.maxOffsetMs} ms`, server, offsetMs };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { status: 'failed', reason: `no NTP server answered (${errors.join('; ')})` };
}

/** Caches the last result so readiness probes do not send a packet each time. */
export function cachedClockCheck(options: ClockCheckOptions & { ttlMs: number }): () => Promise<ClockStatus> {
  const now = options.now ?? Date.now;
  let last: { at: number; result: Promise<ClockStatus> } | undefined;
  return () => {
    const t = now();
    if (!last || t - last.at >= options.ttlMs) last = { at: t, result: checkClock(options) };
    return last.result;
  };
}
