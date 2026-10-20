import net from 'node:net';
import { hostname as osHostname } from 'node:os';
import tls from 'node:tls';
import { PortError, type AuditCheckpoint, type AuditSink, type EgressGuard } from '@form/ports';
import { checkCheckpoint } from './checkpoint.ts';

export interface SyslogAuditSinkOptions {
  /** `tcp://host:port` or `tls://host:port` (RFC 5425; the customer's SIEM usually listens on 6514). */
  url: string;
  /** PEM CA bundle for `tls://` when the SIEM's certificate is not publicly trusted. */
  ca?: string | undefined;
  /** Holds the SIEM to EGRESS_POLICY (a trusted endpoint: operator configuration) and pins the connection to the vetted address. */
  egress: EgressGuard;
  appName?: string;
  hostname?: string;
  timeoutMs?: number;
  /** Clock for the syslog TIMESTAMP; injectable for tests. */
  now?: () => Date;
}

/** facility 13 (log audit), severity 5 (notice). */
const PRI = 13 * 8 + 5;
const PRINTUSASCII = /[^\x21-\x7e]/g;

const field = (v: string, max: number) => v.replace(PRINTUSASCII, '_').slice(0, max) || '-';

/** One RFC 5424 message with RFC 6587 octet-counting framing; the MSG is the checkpoint as JSON. */
export function syslogFrame(cp: AuditCheckpoint, o: { appName: string; hostname: string; now: Date }): Buffer {
  const header = `<${PRI}>1 ${o.now.toISOString()} ${field(o.hostname, 255)} ${field(o.appName, 48)} - fr.audit.checkpoint -`;
  const msg = Buffer.from(`${header} ${JSON.stringify(cp)}`, 'utf8');
  return Buffer.concat([Buffer.from(`${msg.byteLength} `, 'ascii'), msg]);
}

/**
 * The SIEM fallback of `audit.checkpoint` when the audit bucket has no Object Lock (architecture §2.7, §6):
 * one connection per checkpoint (hourly per chain), resolved once the peer has the bytes and the socket closed.
 */
export function createSyslogAuditSink(o: SyslogAuditSinkOptions): AuditSink {
  const u = new URL(o.url);
  if (u.protocol !== 'tcp:' && u.protocol !== 'tls:') throw new PortError('invalid_argument', `syslog sink: expected tcp:// or tls://, got ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'tls:' ? 6514 : 514));
  const timeoutMs = o.timeoutMs ?? 5000;
  const appName = o.appName ?? 'form';
  const hostname = o.hostname ?? osHostname();
  const now = o.now ?? (() => new Date());

  return {
    kind: 'syslog',
    async forward(cp) {
      const frame = syslogFrame(checkCheckpoint(cp), { appName, hostname, now: now() });
      const address = (await o.egress.assertAllowed(u)).pinnedIp;
      return new Promise<void>((resolve, reject) => {
        const socket =
          u.protocol === 'tls:'
            ? tls.connect({ host: address, port, servername: net.isIP(host) ? undefined : host, ...(o.ca ? { ca: o.ca } : {}) })
            : net.connect({ host: address, port });
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(new PortError('unavailable', `syslog sink ${host}:${port}: ${err.message}`, { cause: err }));
        };
        socket.setTimeout(timeoutMs, () => fail(new Error(`no answer within ${timeoutMs} ms`)));
        socket.once('error', fail);
        socket.once(u.protocol === 'tls:' ? 'secureConnect' : 'connect', () => socket.end(frame));
        socket.once('close', (hadError) => {
          if (settled || hadError) return;
          settled = true;
          resolve();
        });
      });
    },
  };
}
