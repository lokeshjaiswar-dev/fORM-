import net from 'node:net';
import { toIsoInstant, type AVScanner, type ByteStream, type EgressGuard, type IsoInstant, type ScanResult } from '@form/ports';

export interface ClamAvOptions {
  /** `CLAMAV_HOST` (`clamav:3310`): clamd inside the cluster, never a remote service. */
  host: string;
  port: number;
  /** Holds clamd to EGRESS_POLICY (a trusted endpoint: operator configuration) and pins the connection to the vetted address. */
  egress: EgressGuard;
  timeoutMs?: number;
  /** INSTREAM chunk size; clamd's StreamMaxLength still caps the whole file. Default 64 KiB. */
  chunkBytes?: number;
}

const MAX_REPLY = 64 * 1024;

/** One clamd command over a fresh connection, after the egress guard; resolves with the NUL-terminated reply. */
async function clamd(o: ClamAvOptions, write: (socket: net.Socket) => Promise<void>): Promise<string> {
  const hostname = o.host.replace(/^\[|\]$/g, '');
  const { pinnedIp } = await o.egress.assertAllowed({
    href: `tcp://${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${o.port}/`,
    protocol: 'tcp:',
    hostname,
    port: String(o.port),
  });
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: pinnedIp, port: o.port });
    const parts: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (err: Error | null, reply?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply ?? '');
    };
    socket.setTimeout(o.timeoutMs ?? 30_000, () => finish(new Error(`clamd ${o.host}:${o.port} timed out`)));
    socket.on('error', (e) => finish(e));
    socket.on('data', (c: Buffer) => {
      length += c.length;
      if (length > MAX_REPLY) return finish(new Error('clamd reply too long'));
      parts.push(c);
      const text = Buffer.concat(parts).toString('utf8');
      if (text.includes('\0')) finish(null, text.slice(0, text.indexOf('\0')));
    });
    socket.on('end', () => finish(null, Buffer.concat(parts).toString('utf8').replace(/\0$/, '')));
    socket.once('connect', () => {
      write(socket).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  });
}

async function drain(it: AsyncIterator<Uint8Array>): Promise<void> {
  while (!(await it.next()).done);
}

const frame = (chunk: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(chunk.byteLength);
  return Buffer.concat([len, chunk]);
};

/** `ClamAV 1.5.3/27791/Mon Oct 19 08:24:01 2026` → engine `1.5.3/27791` and the signature date. */
export function parseClamVersion(reply: string): { engineVersion: string; signaturesUpdatedAt?: IsoInstant } {
  const [engine = '', db, ...date] = reply.trim().replace(/^ClamAV\s+/, '').split('/');
  const when = date.length > 0 ? new Date(`${date.join('/')} UTC`) : undefined;
  return {
    engineVersion: db ? `${engine}/${db}` : engine || 'unknown',
    ...(when && !Number.isNaN(when.getTime()) ? { signaturesUpdatedAt: toIsoInstant(when) } : {}),
  };
}

/**
 * clamd over TCP (architecture §4.6, `AV_DRIVER=clamav`): INSTREAM in chunks, so files never touch the scanner's disk.
 * The stream is always consumed to the end, even when clamd fails or stops reading, so a tee feeding the scanner
 * never stalls; a failure, an egress denial included, is the verdict `error`, which never releases a file.
 */
export function createClamAvScanner(o: ClamAvOptions): AVScanner {
  const chunkBytes = o.chunkBytes ?? 64 * 1024;
  let engine = 'clamav';

  return {
    async scan(stream: ByteStream): Promise<ScanResult> {
      const it = stream[Symbol.asyncIterator]();
      let reply: string;
      try {
        reply = await clamd(o, async (socket) => {
          const send = (b: Buffer) =>
            new Promise<void>((resolve, reject) => {
              if (socket.destroyed) return reject(new Error('clamd closed the connection'));
              socket.write(b, (err) => (err ? reject(err) : resolve()));
            });
          await send(Buffer.from('zINSTREAM\0'));
          for (let r = await it.next(); !r.done; r = await it.next()) {
            for (let i = 0; i < r.value.byteLength; i += chunkBytes) await send(frame(r.value.subarray(i, i + chunkBytes)));
          }
          await send(Buffer.alloc(4));
        });
      } catch {
        await drain(it).catch(() => {});
        return { verdict: 'error', engineVersion: engine };
      }
      await drain(it);
      const m = /^stream: (.+) FOUND$/.exec(reply);
      if (m) return { verdict: 'infected', signature: m[1]!, engineVersion: engine };
      if (reply === 'stream: OK') return { verdict: 'clean', engineVersion: engine };
      return { verdict: 'error', engineVersion: engine };
    },

    async health() {
      try {
        if ((await clamd(o, async (s) => void s.write('zPING\0'))) !== 'PONG') return { ok: false, engineVersion: engine };
        const v = parseClamVersion(await clamd(o, async (s) => void s.write('zVERSION\0')));
        engine = v.engineVersion;
        return { ok: true, ...v };
      } catch {
        return { ok: false, engineVersion: engine };
      }
    },
  };
}
