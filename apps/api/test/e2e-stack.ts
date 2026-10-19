import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeyfileKeyProvider, createSmtpMailer } from '@form/adapters';
import { bootstrapRoles, provision } from '@form/db';
import { createTestDatabase, startMailpit, startMockOidcProvider, startPostgres } from '@form/testkit';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/**
 * The API behind the builder's end-to-end sign-in suite (apps/builder/playwright.stack.config.ts): Postgres and
 * Mailpit in Testcontainers, a mock OpenID provider for "Continue with Google", and the API on a fixed port. The
 * builder's `vite preview` proxies `/v1` here, so the browser sees one origin, as it does behind the ingress.
 * Runs until `stop` arrives on stdin, stdin closes, or SIGINT/SIGTERM; then it stops everything it started.
 */
const STACK = {
  apiPort: Number(process.env.FR_E2E_API_PORT ?? 18180),
  builderUrl: process.env.FR_E2E_BUILDER_URL ?? 'http://localhost:4175',
  mailpit: { smtp: Number(process.env.FR_E2E_SMTP_PORT ?? 18125), api: Number(process.env.FR_E2E_MAILPIT_PORT ?? 18126) },
};

const stops: Array<() => Promise<unknown>> = [];
let stopping = false;
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    for (const s of stops.reverse()) await s().catch(() => {});
  }
  process.exit(code);
}
process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));
process.stdin.on('data', (chunk: Buffer) => {
  if (chunk.toString('utf8').includes('stop')) void stop(0);
});
process.stdin.on('end', () => void stop(0));

try {
  const pgServer = await startPostgres();
  stops.push(() => pgServer.stop());
  const admin = new pg.Client({ connectionString: pgServer.adminUrl() });
  await admin.connect();
  try {
    await bootstrapRoles(admin, TEST_PASSWORDS);
  } finally {
    await admin.end();
  }
  const adminUrl = pgServer.adminUrl();
  const database = await createTestDatabase(adminUrl, 'fr_e2e');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  const mailpit = await startMailpit({ ports: STACK.mailpit });
  stops.push(() => mailpit.stop());
  const google = await startMockOidcProvider({
    clients: [{ clientId: 'fr-e2e', clientSecret: 'e2e-client-secret', redirectUris: [`${STACK.builderUrl}/v1/auth/oauth/google/callback`] }],
  });
  stops.push(() => google.close());
  google.nextUser = { sub: 'google-e2e-user', email: 'ravi.google@example.test', email_verified: true, name: 'Ravi' };

  const parsed = parseConfig({
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'saas',
    HOST: '127.0.0.1',
    PORT: String(STACK.apiPort),
    LOG_LEVEL: process.env.FR_E2E_LOG_LEVEL ?? 'warn',
    DATABASE_URL: urls.fr_app,
    PUBLIC_BUILDER_URL: STACK.builderUrl,
    PUBLIC_API_URL: STACK.builderUrl,
    AUTH_SECRET: randomBytes(32).toString('base64url'),
    SMTP_URL: mailpit.smtpUrl,
    MAIL_FROM: 'no-reply@form.test',
    PASSWORD_BREACH_CHECK: 'off',
    OIDC_GOOGLE_CLIENT_ID: 'fr-e2e',
    OIDC_GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
    OIDC_GOOGLE_ISSUER: google.issuer,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  // Every browser request comes from 127.0.0.1 through the preview proxy: room for the per-IP auth bucket.
  const app = await buildApp(parsed.config, {
    keys: createKeyfileKeyProvider({ masterKey: randomBytes(32) }),
    mailer: createSmtpMailer({ url: mailpit.smtpUrl }),
    authLimits: { auth_any: { max: 600, windowSeconds: 60 } },
  });
  stops.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: STACK.apiPort });
  process.stdout.write(`e2e stack: api http://127.0.0.1:${STACK.apiPort}, mailpit ${mailpit.apiUrl}, oidc ${google.issuer}\n`);
} catch (err) {
  process.stderr.write(`e2e stack: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  await stop(1);
}
