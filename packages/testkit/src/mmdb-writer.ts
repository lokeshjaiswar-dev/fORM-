/**
 * A minimal MaxMind DB (format 2.0) writer: an IPv6 tree with IPv4 under ::/96, 24-bit records, and one
 * `{ country: { iso_code } }` record per country, the shape of DB-IP Lite country databases. Test fixtures only:
 * networks must not overlap.
 */
export interface MmdbNetwork {
  /** `1.2.3.0/24` or `2001:db8::/32`. */
  network: string;
  country: string;
}

function ipv4Bytes(s: string): number[] | undefined {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return parts.map(Number);
}

function ipv6Bytes(s: string): number[] {
  let tail: number[] = [];
  let text = s;
  const last = text.lastIndexOf(':');
  const v4 = ipv4Bytes(text.slice(last + 1));
  if (v4) {
    tail = v4;
    text = `${text.slice(0, last + 1)}0:0`;
  }
  const [head = '', rest] = text.split('::');
  const groups = (g: string) => (g === '' ? [] : g.split(':').map((x) => parseInt(x, 16)));
  const h = groups(head);
  const t = rest === undefined ? [] : groups(rest);
  const all = rest === undefined ? h : [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
  if (all.length !== 8 || all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) throw new Error(`bad IPv6 ${s}`);
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** The 128 bits and prefix length of a network in the IPv6 tree. */
function bitsOf(network: string): { bits: number[]; prefix: number } {
  const [addr = '', len] = network.split('/');
  const v4 = ipv4Bytes(addr);
  const bytes = v4 ? [...Array<number>(12).fill(0), ...v4] : ipv6Bytes(addr);
  const prefix = (v4 ? 96 : 0) + Number(len ?? (v4 ? 32 : 128));
  return { bits: bytes.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1)), prefix };
}

type Rec = { kind: 'node'; index: number } | { kind: 'empty' } | { kind: 'data'; offset: number };

const enc = new TextEncoder();
const control = (type: number, size: number): number[] => {
  if (size >= 29) throw new Error('fixture value too long');
  return type <= 7 ? [(type << 5) | size] : [size, type - 7];
};
const str = (s: string) => {
  const b = [...enc.encode(s)];
  return [...control(2, b.length), ...b];
};
const uint = (type: number, v: number | bigint, width: number) => {
  const bytes: number[] = [];
  let n = BigInt(v);
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes.length > width) throw new Error('value too large');
  return [...control(type, bytes.length), ...bytes];
};
const map = (entries: [string, number[]][]) => [...control(7, entries.length), ...entries.flatMap(([k, v]) => [...str(k), ...v])];

export function buildTestMmdb(networks: readonly MmdbNetwork[], o: { buildEpochSec?: number; databaseType?: string } = {}): Uint8Array {
  const data: number[] = [];
  const offsets = new Map<string, number>();
  const nodes: [Rec, Rec][] = [[{ kind: 'empty' }, { kind: 'empty' }]];
  for (const n of networks) {
    let offset = offsets.get(n.country);
    if (offset === undefined) {
      offset = data.length;
      offsets.set(n.country, offset);
      data.push(...map([['country', map([['iso_code', str(n.country)]])]]));
    }
    const { bits, prefix } = bitsOf(n.network);
    let node = 0;
    for (let depth = 0; depth < prefix; depth++) {
      const bit = bits[depth]!;
      const rec = nodes[node]![bit]!;
      if (depth === prefix - 1) {
        if (rec.kind !== 'empty') throw new Error(`overlapping fixture network ${n.network}`);
        nodes[node]![bit] = { kind: 'data', offset };
      } else if (rec.kind === 'node') {
        node = rec.index;
      } else if (rec.kind === 'empty') {
        nodes.push([{ kind: 'empty' }, { kind: 'empty' }]);
        nodes[node]![bit] = { kind: 'node', index: nodes.length - 1 };
        node = nodes.length - 1;
      } else {
        throw new Error(`overlapping fixture network ${n.network}`);
      }
    }
  }
  const count = nodes.length;
  const value = (r: Rec) => (r.kind === 'node' ? r.index : r.kind === 'empty' ? count : count + 16 + r.offset);
  const tree = nodes.flatMap(([l, r]) => [value(l), value(r)].flatMap((v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]));
  const metadata = map([
    ['binary_format_major_version', uint(5, 2, 2)],
    ['binary_format_minor_version', uint(5, 0, 2)],
    ['build_epoch', uint(9, o.buildEpochSec ?? 1_790_000_000, 8)],
    ['database_type', str(o.databaseType ?? 'DBIP-Country-Lite')],
    ['description', map([])],
    ['ip_version', uint(5, 6, 2)],
    ['languages', control(11, 0)],
    ['node_count', uint(6, count, 4)],
    ['record_size', uint(5, 24, 2)],
  ]);
  return new Uint8Array([...tree, ...Array<number>(16).fill(0), ...data, 0xab, 0xcd, 0xef, ...enc.encode('MaxMind.com'), ...metadata]);
}
