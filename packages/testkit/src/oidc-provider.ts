import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** Who signs in at the mock provider's next authorization request. */
export interface MockOidcUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Extra ID token claims (`xms_edov`, `tid`, …). */
  claims?: Record<string, unknown>;
}

export interface MockOidcClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  nonce: string | null;
  scope: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}

export interface MockOidcProvider {
  /** `http://127.0.0.1:<port>`; also the ID token `iss`. */
  readonly issuer: string;
  /** The user the next `/authorize` signs in; `null` answers `access_denied`. */
  nextUser: MockOidcUser | null;
  /** Changes the next ID token only (wrong nonce, audience, issuer, …), for negative cases. */
  tamperNextIdToken: ((claims: Record<string, unknown>) => Record<string, unknown>) | null;
  readonly authorizations: readonly AuthorizationRequest[];
  /** Follows the provider's side of a redirect from `/authorize` and returns the callback URL with `code` and `state`. */
  authorize(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * A minimal OpenID Connect provider for tests (authorization code flow with PKCE, RS256 ID tokens, discovery and
 * JWKS), so the API's Google and Microsoft sign-in runs against a real HTTP exchange without the internet. It
 * checks the client, the redirect URI, the PKCE verifier and single use of codes, like a real provider.
 */
export async function startMockOidcProvider(o: { clients: MockOidcClient[] }): Promise<MockOidcProvider> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = b64u(randomBytes(8));
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { req: AuthorizationRequest; user: MockOidcUser }>();
  const authorizations: AuthorizationRequest[] = [];
  const sockets = new Set<Socket>();
  let issuer = '';

  const sign = (claims: Record<string, unknown>) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64u(sig)}`;
  };

  const clientAuth = (req: IncomingMessage, form: URLSearchParams): MockOidcClient | undefined => {
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (basic) {
      const [u, p] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    return o.clients.find((c) => c.clientId === id && c.clientSecret === secret);
  };

  const provider: MockOidcProvider = {
    get issuer() {
      return issuer;
    },
    nextUser: null,
    tamperNextIdToken: null,
    authorizations,
    async authorize(authorizationUrl) {
      const res = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`mock OIDC: /authorize answered ${res.status}`);
      return location;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const q = url.searchParams;
        const a: AuthorizationRequest = {
          clientId: q.get('client_id') ?? '',
          redirectUri: q.get('redirect_uri') ?? '',
          state: q.get('state'),
          nonce: q.get('nonce'),
          scope: q.get('scope'),
          codeChallenge: q.get('code_challenge'),
          codeChallengeMethod: q.get('code_challenge_method'),
        };
        authorizations.push(a);
        const c = o.clients.find((x) => x.clientId === a.clientId);
        if (!c || !c.redirectUris.includes(a.redirectUri) || q.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' });
        const back = new URL(a.redirectUri);
        if (a.state !== null) back.searchParams.set('state', a.state);
        const user = provider.nextUser;
        if (!user) {
          back.searchParams.set('error', 'access_denied');
        } else {
          const code = b64u(randomBytes(24));
          codes.set(code, { req: a, user });
          back.searchParams.set('code', code);
        }
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(req));
        const client = clientAuth(req, form);
        if (!client) return json(res, 401, { error: 'invalid_client' });
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (form.get('grant_type') !== 'authorization_code' || !grant || grant.req.clientId !== client.clientId || grant.req.redirectUri !== form.get('redirect_uri')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const verifier = form.get('code_verifier') ?? '';
        if (grant.req.codeChallengeMethod !== 'S256' || b64u(createHash('sha256').update(verifier).digest()) !== grant.req.codeChallenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        const now = Math.floor(Date.now() / 1000);
        let claims: Record<string, unknown> = {
          iss: issuer,
          aud: client.clientId,
          sub: grant.user.sub,
          iat: now,
          exp: now + 300,
          ...(grant.req.nonce !== null ? { nonce: grant.req.nonce } : {}),
          ...(grant.user.email !== undefined ? { email: grant.user.email } : {}),
          ...(grant.user.email_verified !== undefined ? { email_verified: grant.user.email_verified } : {}),
          ...(grant.user.name !== undefined ? { name: grant.user.name } : {}),
          ...grant.user.claims,
        };
        if (provider.tamperNextIdToken) {
          claims = provider.tamperNextIdToken(claims);
          provider.tamperNextIdToken = null;
        }
        return json(res, 200, { access_token: b64u(randomBytes(24)), token_type: 'Bearer', expires_in: 300, scope: 'openid email profile', id_token: sign(claims) });
      }
      return json(res, 404, { error: 'not_found' });
    })().catch((err: unknown) => json(res, 500, { error: 'server_error', error_description: String(err) }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return provider;
}
