import { createHash, createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockOidcProvider, type MockOidcProvider } from './oidc-provider.ts';

const REDIRECT = 'https://api.test/callback';
let op: MockOidcProvider;

beforeAll(async () => {
  op = await startMockOidcProvider({ clients: [{ clientId: 'c1', clientSecret: 's1', redirectUris: [REDIRECT] }] });
});
afterAll(() => op?.close());

const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

function authorizeUrl(over: Record<string, string> = {}): string {
  const q = new URLSearchParams({ client_id: 'c1', redirect_uri: REDIRECT, response_type: 'code', state: 'st', nonce: 'no', code_challenge: challenge, code_challenge_method: 'S256', ...over });
  return `${op.issuer}/authorize?${q}`;
}

async function token(code: string, over: Record<string, string> = {}) {
  return fetch(`${op.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from('c1:s1').toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...over }),
  });
}

describe('mock OpenID provider', () => {
  it('serves discovery and a JWKS', async () => {
    const meta = (await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: op.issuer, token_endpoint: `${op.issuer}/token`, code_challenge_methods_supported: ['S256'] });
    const { keys } = (await (await fetch(`${op.issuer}/jwks`)).json()) as { keys: Array<{ kty: string; kid: string }> };
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256' });
  });

  it('runs the code flow with PKCE and signs an ID token for the next user', async () => {
    op.nextUser = { sub: 'u-1', email: 'a@b.test', email_verified: true, claims: { xms_edov: true } };
    const back = new URL(await op.authorize(authorizeUrl()));
    expect(back.searchParams.get('state')).toBe('st');
    const code = back.searchParams.get('code')!;
    const res = await token(code);
    expect(res.status).toBe(200);
    const { id_token } = (await res.json()) as { id_token: string };
    const [head, body, sig] = id_token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: op.issuer, aud: 'c1', sub: 'u-1', nonce: 'no', email: 'a@b.test', email_verified: true, xms_edov: true });
    const { keys } = (await (await fetch(`${op.issuer}/jwks`)).json()) as { keys: Array<Record<string, unknown>> };
    const key = createPublicKey({ key: keys[0] as never, format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(sig, 'base64url'))).toBe(true);
    // Codes are single-use.
    expect((await token(code)).status).toBe(400);
  });

  it('refuses a wrong PKCE verifier, client or redirect URI, and answers access_denied with no user', async () => {
    op.nextUser = { sub: 'u-2' };
    const code = new URL(await op.authorize(authorizeUrl())).searchParams.get('code')!;
    expect((await token(code, { code_verifier: 'w'.repeat(43) })).status).toBe(400);
    expect((await fetch(authorizeUrl({ redirect_uri: 'https://evil.test/cb' }))).status).toBe(400);
    const badClient = await fetch(`${op.issuer}/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'c1', client_secret: 'nope', grant_type: 'authorization_code', code: 'x' }) });
    expect(badClient.status).toBe(401);
    op.nextUser = null;
    expect(new URL(await op.authorize(authorizeUrl())).searchParams.get('error')).toBe('access_denied');
    expect(op.authorizations.at(-1)).toMatchObject({ clientId: 'c1', codeChallengeMethod: 'S256', nonce: 'no' });
  });

  it('can tamper with the next ID token only', async () => {
    op.nextUser = { sub: 'u-3' };
    op.tamperNextIdToken = (c) => ({ ...c, aud: 'someone-else' });
    const first = (await (await token(new URL(await op.authorize(authorizeUrl())).searchParams.get('code')!)).json()) as { id_token: string };
    const second = (await (await token(new URL(await op.authorize(authorizeUrl())).searchParams.get('code')!)).json()) as { id_token: string };
    const aud = (t: string) => (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as { aud: string }).aud;
    expect([aud(first.id_token), aud(second.id_token)]).toEqual(['someone-else', 'c1']);
  });
});
