import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeyfileKeyProvider } from '@form/adapters/kms';
import { createSmtpMailer } from '@form/adapters/mailer';
import { createPostgresSearchIndex } from '@form/adapters/search';
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
/** How long one stop may take. A close that hangs (a keep-alive socket of the browser) must not keep the containers running. */
const STOP_STEP_MS = 15_000;
let stopping: Promise<void> | undefined;
/**
 * Stops everything that was started, newest first, then exits. Each step is bounded, so the containers (started first,
 * stopped last) are always removed. A second request to stop (`stop` on stdin, then stdin closing, then a SIGTERM from a
 * runner that grew impatient) waits for the first one instead of exiting halfway: exiting before the container stops have
 * run leaves Postgres and Mailpit running on the Docker host, where nothing else removes them (Ryuk is off).
 */
function stop(code: number): Promise<never> {
  stopping ??= (async () => {
    for (const s of stops.reverse()) {
      await Promise.race([s().catch(() => {}), new Promise((r) => setTimeout(r, STOP_STEP_MS).unref())]);
    }
  })();
  return stopping.then(() => process.exit(code));
}
// `on`, not `once`: a group SIGTERM reaches this process twice (directly, and relayed by tsx), and a second signal with no
// handler left would kill it before the containers are stopped.
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
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
    // The responses grid's search (WP-1.15) answers 503 without a search index, as main.ts gives it one.
    searchIndex: createPostgresSearchIndex,
    authLimits: { auth_any: { max: 600, windowSeconds: 60 } },
  });
  stops.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: STACK.apiPort });
  process.stdout.write(`e2e stack: api http://127.0.0.1:${STACK.apiPort}, mailpit ${mailpit.apiUrl}, oidc ${google.issuer}\n`);
} catch (err) {
  process.stderr.write(`e2e stack: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  await stop(1);
}
