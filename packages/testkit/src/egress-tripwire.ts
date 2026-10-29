import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/**
 * A process-wide record of every socket connection and every DNS lookup, for the egress-blocked runs (WP-1.03,
 * architecture §7.4): with on-prem implementations under `EGRESS_POLICY=none`, the only destinations allowed are the
 * loopback services the test itself started. Anything else is a violation, whether or not it would have succeeded.
 */
export interface EgressTripwire {
  /** `host:port` (or a socket path) of every connect, in order. */
  readonly connections: readonly string[];
  /** Every name passed to `dns.lookup`. */
  readonly lookups: readonly string[];
  /** Connections and lookups outside loopback. */
  violations(): string[];
  uninstall(): void;
}

const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost']);

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  if (net.isIPv6(h)) return h === '::1' || /^::ffff:127\./.test(h);
  return false;
}

type ConnectArgs = unknown[];

function target(args: ConnectArgs): string {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return `unix:${o.path}`;
    return `${o.host ?? 'localhost'}:${o.port ?? ''}`;
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return `unix:${first}`;
  return `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`;
}

export function installEgressTripwire(): EgressTripwire {
  const connections: string[] = [];
  const lookups: string[] = [];
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;

  net.Socket.prototype.connect = function (this: net.Socket, ...args: ConnectArgs) {
    connections.push(target(args));
    return (originalConnect as (...a: ConnectArgs) => net.Socket).apply(this, args);
  } as typeof originalConnect;
  dns.lookup = function (hostname: string, ...rest: unknown[]) {
    lookups.push(hostname);
    return (originalLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest);
  } as typeof dns.lookup;
  dns.promises.lookup = function (hostname: string, ...rest: unknown[]) {
    lookups.push(hostname);
    return (originalPromiseLookup as (...a: unknown[]) => Promise<unknown>).call(dns.promises, hostname, ...rest);
  } as typeof dns.promises.lookup;
  syncBuiltinESMExports();

  return {
    connections,
    lookups,
    violations() {
      const hostOf = (c: string) => (c.startsWith('unix:') ? 'localhost' : c.slice(0, c.lastIndexOf(':')));
      return [...connections.filter((c) => !isLoopback(hostOf(c))).map((c) => `connect ${c}`), ...lookups.filter((h) => !isLoopback(h)).map((h) => `lookup ${h}`)];
    },
    uninstall() {
      net.Socket.prototype.connect = originalConnect;
      dns.lookup = originalLookup;
      dns.promises.lookup = originalPromiseLookup;
      syncBuiltinESMExports();
    },
  };
}
