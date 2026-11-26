import { describe, expect, it } from 'vitest';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { B64URL_43_RE } from '@/embed/contract';
import { base64url, challengeOf, newRequestId, newVerifier, sha256Fallback } from './pkce';

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('PKCE pieces', () => {
  it('a verifier is 43 base64url characters and differs every time', () => {
    const a = newVerifier();
    expect(a).toMatch(B64URL_43_RE);
    expect(newVerifier()).not.toBe(a);
  });

  it('the S256 challenge matches every pair of the contract fixtures (RFC 7636 appendix B among them)', async () => {
    for (const c of ticketFx.pkce) {
      const challenge = await challengeOf(c.input.verifier);
      expect(challenge === c.input.challenge).toBe(c.expect.valid);
    }
  });

  it('the pure SHA-256 (used where crypto.subtle is missing, an http LAN origin) gives the standard digests', () => {
    expect(hex(sha256Fallback(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256Fallback(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // two blocks (the 56-byte message forces a second padding block)
    expect(hex(sha256Fallback(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(base64url(sha256Fallback(enc('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')))).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('request ids are UUID v4', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
