import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { PortError, type EgressGuard, type EgressTarget } from '@form/ports';

export type EgressPolicyName = 'open' | 'allowlist' | 'none';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a name resolves to; the default is the system resolver (`getaddrinfo`). */
export type EgressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressGuardOptions {
  /** `EGRESS_POLICY` (architecture §1.5). */
  policy: EgressPolicyName;
  /** `EGRESS_ALLOWLIST`: `host` or `host:port`. `allowlist` and `none` reach only these; `open` ignores it. */
  allowlist?: readonly string[];
  /**
   * Endpoints the operator configured (KMS, object store, SMTP relay, SIEM; `host` or `host:port`). They pass as if
   * allowlisted and may sit on private addresses under `open` too (a VPC endpoint, the dev stack on localhost), but
   * under `none` they still must not resolve to a public address. Tenant-supplied destinations never belong here.
   */
  trusted?: readonly string[];
  /** URL schemes the caller may use. Default: https, http, smtp, smtps, tcp and tls (syslog). */
  protocols?: readonly string[];
  resolve?: EgressResolver;
}

const DEFAULT_PROTOCOLS = ['https:', 'http:', 'smtp:', 'smtps:', 'tcp:', 'tls:'];
export const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'https:': 443, 'http:': 80, 'smtp:': 25, 'smtps:': 465, 'tcp:': 514, 'tls:': 6514 };

function blockList(v4: readonly string[], v6: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of v4) {
    const [net, bits] = cidr.split('/') as [string, string];
    list.addSubnet(net, Number(bits), 'ipv4');
  }
  for (const cidr of v6) {
    const i = cidr.lastIndexOf('/');
    list.addSubnet(cidr.slice(0, i), Number(cidr.slice(i + 1)), 'ipv6');
  }
  return list;
}

/** Never reachable under any policy: unspecified, link-local (cloud metadata), multicast and reserved space. */
const NEVER = blockList(
  ['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'],
  ['::/128', 'fe80::/10', 'fec0::/10', 'ff00::/8'],
);

/** Not the public internet: private, loopback, shared, benchmarking, documentation and translation ranges (IANA special-purpose registries). */
const NON_PUBLIC = blockList(
  ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'],
  ['::1/128', '::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7'],
);

/** `::ffff:a.b.c.d` is the IPv4 address it embeds. */
function canonical(address: string): { address: string; type: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1]!, type: 'ipv4' };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return { address: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, type: 'ipv4' };
  }
  return { address, type: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

export type AddressClass = 'never' | 'non_public' | 'public';

export function classifyAddress(address: string): AddressClass {
  const c = canonical(address);
  if (NEVER.check(c.address, c.type)) return 'never';
  if (NON_PUBLIC.check(c.address, c.type)) return 'non_public';
  return 'public';
}

const denied = (url: EgressTarget, why: string) => new PortError('egress_denied', `egress to ${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''} denied: ${why}`);

/** Lower-case, without the brackets of an IPv6 literal or a trailing root dot. */
function normaliseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

interface AllowEntry {
  host: string;
  port?: number;
}

function parseAllowlist(entries: readonly string[]): AllowEntry[] {
  return entries.map((e) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(e.trim());
    if (!m) throw new PortError('invalid_argument', `invalid egress allowlist entry ${JSON.stringify(e)}`);
    return m[2] === undefined ? { host: normaliseHost(m[1]!) } : { host: normaliseHost(m[1]!), port: Number(m[2]) };
  });
}

const systemResolver: EgressResolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

/**
 * The egress guard of architecture §6: `open` (SaaS) reaches the public internet only; `allowlist` (on-prem) reaches
 * only `EGRESS_ALLOWLIST`; `none` (air-gapped) reaches only allowlisted hosts that resolve to non-public addresses, so
 * nothing can leave the network even through a misconfigured DNS answer. Names are resolved once and every answer
 * must pass; the first one is pinned. Link-local (cloud metadata), multicast and unspecified addresses never pass.
 * `trusted` endpoints (operator configuration) pass the allowlist and, except under `none`, the address-class check.
 */
export function createEgressGuard(o: EgressGuardOptions): EgressGuard {
  const protocols = new Set(o.protocols ?? DEFAULT_PROTOCOLS);
  const allow = parseAllowlist(o.policy === 'open' ? [] : (o.allowlist ?? []));
  const resolve = o.resolve ?? systemResolver;

  const trust = parseAllowlist(o.trusted ?? []);
  const listed = (list: AllowEntry[], host: string, port: number) => list.some((a) => a.host === host && (a.port === undefined || a.port === port));

  return {
    async assertAllowed(url) {
      if (!protocols.has(url.protocol)) throw denied(url, `scheme ${url.protocol} is not allowed`);
      const host = normaliseHost(url.hostname);
      if (host.length === 0) throw denied(url, 'no host');
      const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
      if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw denied(url, 'invalid port');
      const trusted = listed(trust, host, port);
      if (o.policy !== 'open' && !trusted && !listed(allow, host, port)) throw denied(url, `not in EGRESS_ALLOWLIST (EGRESS_POLICY=${o.policy})`);

      let addresses: ResolvedAddress[];
      if (isIP(host) !== 0) {
        addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
      } else {
        try {
          addresses = await resolve(host);
        } catch (e) {
          throw new PortError('egress_denied', `egress to ${host} denied: it does not resolve`, { cause: e });
        }
      }
      if (addresses.length === 0) throw denied(url, 'it does not resolve');
      for (const { address } of addresses) {
        const c = classifyAddress(address);
        if (c === 'never') throw denied(url, `${address} is never reachable`);
        if (o.policy === 'open' && c !== 'public' && !trusted) throw denied(url, `${address} is not a public address`);
        if (o.policy === 'none' && c === 'public') throw denied(url, `${address} is a public address and EGRESS_POLICY=none`);
      }
      return { pinnedIp: canonical(addresses[0]!.address).address };
    },
  };
}
