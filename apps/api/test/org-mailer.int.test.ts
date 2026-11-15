import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createTenantEgressGuard } from '@form/adapters/egress';
import { createKeyfileKeyProvider, createOrgSecrets } from '@form/adapters/kms';
import { createSmtpMailer } from '@form/adapters/mailer';
import { parseEditionConfig } from '@form/config';
import { createDb, provision, secrets, withTenant, type DbHandle } from '@form/db';
import type { KeyContext, KeyProvider, Mailer, OrgSecrets } from '@form/ports';
import { createTestDatabase } from '@form/testkit';
import { createOrgMailer, type OrgSmtpSenders } from '../src/org-mailer.ts';
import { TEST_PASSWORDS } from './global-setup.ts';

/*
 * WP-1.16: the org mailer of the composition root, on a real database, a real KMS and the real SMTP mailer. The unit test in
 * `src/app.test.ts` proves the wiring with fakes; this one proves what the database and the key actually do: `secret_enc()`
 * answers a system context of one org for that org's secret only, and the key of an org cannot open another org's secret.
 */

const URL_A = 'smtp://org-a-user:org-a-pass@127.0.0.1:2525';
const URL_B = 'smtp://org-b-user:org-b-pass@127.0.0.1:2526';

let appDb: DbHandle;
let orgSecrets: OrgSecrets;
let unwraps: KeyContext[];
let orgA: string;
let orgB: string;
let secretA: string;
let secretB: string;
let webhookSecretA: string;
let senders: OrgSmtpSenders[];
let mailerFor: (orgId: string) => Mailer;

/** The real keyfile KMS, wrapped to record every context it is asked to unwrap under. */
function recordingKms(): KeyProvider {
  const real = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
  return {
    ...real,
    unwrap: (wrapped, ref, ctx) => {
      unwraps.push({ ...ctx });
      return real.unwrap(wrapped, ref, ctx);
    },
  };
}

async function store(orgId: string, id: string, kind: 'smtp' | 'webhook_hmac', plaintext: string): Promise<void> {
  const enc = await orgSecrets.seal({ orgId, secretId: id, kind }, plaintext);
  await withTenant(appDb.db, { orgId, actor: 'system', requestId: `test:${randomUUID()}` }, (tx) => tx.insert(secrets).values({ id, orgId, kind, enc: enc as unknown as Record<string, unknown> }));
}

beforeAll(async () => {
  const adminUrl = inject('pgAdminUrl');
  const database = await createTestDatabase(adminUrl, 'fr_api_org_mailer');
  const { urls } = await provision({ adminUrl, database, passwords: TEST_PASSWORDS, roles: false });
  appDb = createDb(urls.fr_app, { max: 4, applicationName: 'fr-api-org-mailer-test' });
  unwraps = [];
  orgSecrets = createOrgSecrets(recordingKms());
  orgA = randomUUID();
  orgB = randomUUID();
  secretA = randomUUID();
  secretB = randomUUID();
  webhookSecretA = randomUUID();
  const owner = new pg.Pool({ connectionString: urls.fr_migrator, max: 1 });
  try {
    await owner.query('insert into orgs (id, slug, name) values ($1, $3, $3), ($2, $4, $4)', [orgA, orgB, 'org-mailer-a', 'org-mailer-b']);
  } finally {
    await owner.end();
  }
  await store(orgA, secretA, 'smtp', URL_A);
  await store(orgB, secretB, 'smtp', URL_B);
  await store(orgA, webhookSecretA, 'webhook_hmac', 'a-webhook-signing-key');
  unwraps.length = 0;
  senders = [];
  const edition = parseEditionConfig({ DEPLOYMENT_MODE: 'onprem' });
  if (!edition.ok) throw new Error(edition.errors.join('\n'));
  // What `main.ts` does: the tenant guard (EGRESS_POLICY=allowlist, nothing allowlisted) and the real SMTP mailer around the senders.
  const tenantEgress = createTenantEgressGuard(edition.config);
  mailerFor = createOrgMailer({
    db: appDb.db,
    orgSecrets,
    tenantEgress,
    makeSmtpMailer: (s) => {
      senders.push(s);
      return createSmtpMailer({ url: 'smtp://127.0.0.1:1', senders: s });
    },
  });
});

afterAll(async () => {
  await appDb?.close();
});

describe('the org mailer on a real database and key', () => {
  it("opens an org's own SMTP secret, as a system context of that org and under that org's key only", async () => {
    unwraps.length = 0;
    mailerFor(orgA);
    expect(await senders.at(-1)!.resolve(secretA)).toBe(URL_A);
    expect(unwraps).toEqual([{ orgId: orgA }]);
  });

  it("answers no sender for another org's secret, and the KMS is never asked about it", async () => {
    unwraps.length = 0;
    const mailer = mailerFor(orgA);
    expect(await senders.at(-1)!.resolve(secretB)).toBeUndefined();
    expect(unwraps).toEqual([]);
    // Through the real mailer: no such sender, the same answer as for an id that was never a secret.
    expect(await mailer.verify(secretB)).toEqual({ ok: false, error: 'no such SMTP sender' });
    expect(await mailer.verify(randomUUID())).toEqual({ ok: false, error: 'no such SMTP sender' });
    await expect(mailer.send({ from: { address: 'a@org-a.test' }, to: [{ address: 'x@y.test' }], subject: 's', text: 't', senderSecretRef: secretB })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(unwraps).toEqual([]);
    // And the other org gets its own, not A's.
    mailerFor(orgB);
    expect(await senders.at(-1)!.resolve(secretA)).toBeUndefined();
    expect(await senders.at(-1)!.resolve(secretB)).toBe(URL_B);
    expect(unwraps).toEqual([{ orgId: orgB }]);
  });

  it('does not open a webhook signing secret as an SMTP URL: the kind is part of what the key is bound to', async () => {
    mailerFor(orgA);
    await expect(senders.at(-1)!.resolve(webhookSecretA)).rejects.toMatchObject({ code: 'integrity' });
  });

  it("holds an org's relay to the tenant egress guard, so a private address is refused and the credentials stay out of the answer", async () => {
    const mailer = mailerFor(orgA);
    const checked = await mailer.verify(secretA);
    // The secret was opened (this is the egress check on its URL), and the guard said no: a private address, nothing allowlisted.
    expect(checked).toEqual({ ok: false, error: expect.stringMatching(/^egress to smtp:\/\/127\.0\.0\.1:2525 denied/) });
    expect(JSON.stringify(checked)).not.toMatch(/org-a-pass|org-a-user/);
  });
});
