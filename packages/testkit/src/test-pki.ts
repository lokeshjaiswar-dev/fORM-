import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A throwaway private CA and a server certificate for 127.0.0.1 and localhost, made at runtime (nothing to commit, so no
 * key material in the repository): ECDSA P-256 X.509 v3 in hand-rolled DER. For TLS tests against a private CA.
 */
export interface TestPki {
  /** PEM of the CA certificate: what the client trusts (`AUDIT_SYSLOG_CA_FILE`). */
  caCert: string;
  /** PEM key and certificate for the server. */
  serverKey: string;
  serverCert: string;
}

const der = (tag: number, body: Buffer): Buffer => {
  const len = body.length;
  const head = len < 0x80 ? Buffer.of(len) : len < 0x100 ? Buffer.of(0x81, len) : Buffer.of(0x82, len >> 8, len & 0xff);
  return Buffer.concat([Buffer.of(tag), head, body]);
};
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => der(0x31, Buffer.concat(parts));
const int = (b: Buffer) => der(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.of(0), b]) : b);
const octets = (b: Buffer) => der(0x04, b);
const bits = (b: Buffer) => der(0x03, Buffer.concat([Buffer.of(0), b]));
const explicit = (n: number, b: Buffer) => der(0xa0 + n, b);

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

const utcTime = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`, 'ascii'));
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [der(0x01, Buffer.of(0xff))] : []), octets(value));

function certificate(o: { subject: string; issuer: string; publicKey: KeyObject; signer: KeyObject; ca: boolean }): string {
  const now = Date.now();
  const extensions = o.ca
    ? [extension('2.5.29.19', true, seq(der(0x01, Buffer.of(0xff)))), extension('2.5.29.15', true, bits(Buffer.of(0x06)))]
    : [
        extension('2.5.29.19', true, seq()),
        extension('2.5.29.15', true, bits(Buffer.of(0x80))),
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
        extension('2.5.29.17', false, seq(der(0x82, Buffer.from('localhost', 'ascii')), der(0x87, Buffer.of(127, 0, 0, 1)))),
      ];
  const tbs = seq(
    explicit(0, int(Buffer.of(2))),
    int(Buffer.concat([Buffer.of(0x01), randomBytes(15)])),
    ECDSA_SHA256,
    name(o.issuer),
    seq(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 24 * 3600_000))),
    name(o.subject),
    o.publicKey.export({ format: 'der', type: 'spki' }),
    explicit(3, seq(...extensions)),
  );
  const cert = seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, o.signer)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----\n`;
}

export function createTestPki(): TestPki {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const server = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    caCert: certificate({ subject: 'fORM- test CA', issuer: 'fORM- test CA', publicKey: ca.publicKey, signer: ca.privateKey, ca: true }),
    serverKey: server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    serverCert: certificate({ subject: 'localhost', issuer: 'fORM- test CA', publicKey: server.publicKey, signer: ca.privateKey, ca: false }),
  };
}
