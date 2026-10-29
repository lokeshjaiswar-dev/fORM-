import { hostname as osHostname } from 'node:os';
import { PortError, type AuditSink, type EgressGuard } from '@form/ports';
import { egressHttp } from '../egress/http.ts';
import { hasControlChars } from '../text.ts';
import { checkCheckpoint } from './checkpoint.ts';

export interface OtlpAuditSinkOptions {
  /** OTLP/HTTP base URL of the customer's collector (`AUDIT_OTLP_URL`); records go to `<url>/v1/logs`. */
  url: string;
  /** The collector is operator configuration: pass the guard with it as a trusted endpoint. */
  egress: EgressGuard;
  /** Extra request headers (`AUDIT_OTLP_HEADERS`, e.g. an API key). */
  headers?: Readonly<Record<string, string>>;
  /** PEM CA bundle for a collector behind a private CA. */
  ca?: string | undefined;
  serviceName?: string;
  hostname?: string;
  timeoutMs?: number;
  now?: () => Date;
}

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

/**
 * The OTLP fallback of `audit.checkpoint` (architecture §2.7, §6) for SIEMs fed by an OpenTelemetry Collector: one
 * log record per checkpoint, event `fr.audit.checkpoint`, body the checkpoint JSON. A refusal or a partial success
 * is PortError('unavailable'), so the job retries rather than treating the checkpoint as anchored.
 */
export function createOtlpAuditSink(o: OtlpAuditSinkOptions): AuditSink {
  const base = new URL(o.url);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new PortError('invalid_argument', `OTLP sink: expected http(s)://, got ${base.protocol}`);
  const endpoint = new URL(`${base.href.replace(/\/+$/, '')}/v1/logs`);
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || hasControlChars(v)) throw new PortError('invalid_argument', `OTLP sink: invalid header ${JSON.stringify(k)}`);
  }
  const now = o.now ?? (() => new Date());
  const resource = { attributes: [attr('service.name', o.serviceName ?? 'fr-worker'), attr('host.name', o.hostname ?? osHostname())] };

  return {
    kind: 'otlp',
    async forward(cp) {
      checkCheckpoint(cp);
      const nanos = `${BigInt(now().getTime()) * 1_000_000n}`;
      const record = {
        timeUnixNano: `${BigInt(Date.parse(cp.signedAt)) * 1_000_000n}`,
        observedTimeUnixNano: nanos,
        severityNumber: 10,
        severityText: 'NOTICE',
        eventName: 'fr.audit.checkpoint',
        body: { stringValue: JSON.stringify(cp) },
        attributes: [attr('fr.audit.org_key', cp.orgKey), { key: 'fr.audit.seq', value: { intValue: String(cp.seq) } }, attr('fr.audit.key_id', cp.keyId)],
      };
      const res = await egressHttp(o.egress, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...o.headers },
        body: JSON.stringify({ resourceLogs: [{ resource, scopeLogs: [{ scope: { name: 'form.audit' }, logRecords: [record] }] }] }),
        timeoutMs: o.timeoutMs ?? 5000,
        maxResponseBytes: 64 * 1024,
        ...(o.ca ? { ca: o.ca } : {}),
      });
      if (res.status < 200 || res.status >= 300) throw new PortError('unavailable', `OTLP collector answered ${res.status}`);
      if (res.body.byteLength > 0) {
        const reply = res.json() as { partialSuccess?: { rejectedLogRecords?: unknown; errorMessage?: unknown } };
        const partial = reply.partialSuccess;
        if (Number(partial?.rejectedLogRecords ?? 0) > 0) throw new PortError('unavailable', `OTLP collector rejected the checkpoint: ${String(partial?.errorMessage ?? '')}`);
      }
    },
  };
}
