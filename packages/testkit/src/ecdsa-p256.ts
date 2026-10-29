import { randomBytes, type KeyObject } from 'node:crypto';

/**
 * ECDSA P-256 over a precomputed SHA-256 digest, as Cloud KMS and Key Vault sign (`digest` in, r ‖ s out). Node and
 * WebCrypto only sign whole messages, so the emulators use this. Affine arithmetic on bigints: slow, test use only.
 */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

function inv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

function add(p: Point, q: Point): Point {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x && mod(p.y + q.y, P) === 0n) return null;
  const l = p.x === q.x && p.y === q.y ? mod((3n * p.x * p.x + A) * inv(2n * p.y, P), P) : mod((q.y - p.y) * inv(q.x - p.x, P), P);
  const x = mod(l * l - p.x - q.x, P);
  return { x, y: mod(l * (p.x - x) - p.y, P) };
}

function mul(k: bigint, p: Point): Point {
  let r: Point = null;
  let a = p;
  for (let n = k; n > 0n; n >>= 1n) {
    if (n & 1n) r = add(r, a);
    a = add(a, a);
  }
  return r;
}

const toBig = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const to32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex');

export function signP256Digest(key: KeyObject, digest: Uint8Array): Uint8Array {
  const d = toBig(Buffer.from(key.export({ format: 'jwk' }).d ?? '', 'base64url'));
  const z = toBig(digest);
  for (;;) {
    const k = mod(toBig(randomBytes(32)), N);
    if (k === 0n) continue;
    const r = mod(mul(k, G)!.x, N);
    if (r === 0n) continue;
    const s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    return new Uint8Array(Buffer.concat([to32(r), to32(s)]));
  }
}

/** r ‖ s as DER, as Cloud KMS returns it. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const int = (b: Buffer) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.of(0), v]);
    return Buffer.concat([Buffer.of(0x02, v.length), v]);
  };
  const body = Buffer.concat([int(Buffer.from(sig.subarray(0, 32))), int(Buffer.from(sig.subarray(32)))]);
  return new Uint8Array(Buffer.concat([Buffer.of(0x30, body.length), body]));
}
