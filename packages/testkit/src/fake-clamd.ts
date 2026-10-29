import { createServer, type AddressInfo, type Socket } from 'node:net';
import { eicarSample } from './scan.contract.ts';

export interface FakeClamd {
  host: string;
  port: number;
  /** Bytes received over INSTREAM, across connections. */
  readonly received: number;
  /** Connections accepted so far. */
  readonly connections: number;
  close(): Promise<void>;
}

/**
 * clamd's TCP protocol (`zPING`, `zVERSION`, `zINSTREAM` with length-prefixed chunks) with one signature, EICAR, so the
 * ClamAV adapter's framing and replies are tested in every run; the real engine is the opt-in container.
 */
export async function startFakeClamd(o: { streamMaxBytes?: number } = {}): Promise<FakeClamd> {
  const max = o.streamMaxBytes ?? 25 * 1024 * 1024;
  const eicar = Buffer.from(eicarSample());
  let received = 0;
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    let command: string | undefined;
    const body: Buffer[] = [];
    let size = 0;
    const reply = (text: string) => socket.end(`${text}\0`);
    socket.on('error', () => {});
    socket.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (command === undefined) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        command = buf.subarray(0, nul).toString('ascii');
        buf = buf.subarray(nul + 1);
        if (command === 'zPING') return reply('PONG');
        if (command === 'zVERSION') return reply('ClamAV 1.5.3/27791/Mon Oct 19 08:24:01 2026');
        if (command !== 'zINSTREAM') return reply('UNKNOWN COMMAND');
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const all = Buffer.concat(body);
          return reply(all.includes(eicar) ? 'stream: Eicar-Signature FOUND' : 'stream: OK');
        }
        if (buf.length < 4 + len) return;
        body.push(buf.subarray(4, 4 + len));
        size += len;
        received += len;
        buf = buf.subarray(4 + len);
        if (size > max) return reply('INSTREAM size limit exceeded. ERROR');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    host: '127.0.0.1',
    port,
    get received() {
      return received;
    },
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
