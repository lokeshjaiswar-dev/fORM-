import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, FormDefinitionSchema, sha256Jcs } from '../src/index.ts';
import { definition } from './fixtures.ts';

describe('canonical JSON (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], A: {} })).toBe('{"A":{},"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ '€': 1, '\r': 2, '1': 3, ö: 4 })).toBe('{"\\r":2,"1":3,"ö":4,"€":1}');
  });

  it('serialises numbers the ECMAScript way', () => {
    expect(canonicalJson([1e30, 1e-7, 0.000001, -0, 4.5, 333333333.3333333])).toBe('[1e+30,1e-7,0.000001,0,4.5,333333333.3333333]');
  });

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
    expect(() => canonicalJson('\uD800')).toThrow();
  });
});

describe('contentHash = sha256(JCS(x))', () => {
  it('matches known digests', () => {
    expect(sha256Jcs({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(sha256Jcs('é')).toBe(bytesToHex(sha256(new Uint8Array([0x22, 0xc3, 0xa9, 0x22]))));
  });

  it('ignores key order and survives a parse round trip', () => {
    const def = definition();
    const reordered = Object.fromEntries(Object.entries(def).reverse());
    expect(contentHash(reordered)).toBe(contentHash(def));
    expect(contentHash(FormDefinitionSchema.parse(JSON.parse(JSON.stringify(def))))).toBe(contentHash(def));
    expect(contentHash(def)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when content changes', () => {
    const a = definition();
    const b = { ...definition(), title: 'Other' };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});
