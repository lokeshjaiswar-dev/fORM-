import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEditionConfig } from '@form/config';
import {
  auditCheckpointFixture,
  buildTestMmdb,
  eicarSample,
  expectPortError,
  installEgressTripwire,
  solveAltcha,
  startFakeClamd,
  startOtlpLogReceiver,
  startSmtpSink,
  startSyslogReceiver,
  trackedStream,
  utf8,
  type EgressTripwire,
} from '@form/testkit';
import { createOtlpAuditSink, createSyslogAuditSink } from './audit-sink/index.ts';
import { createMemoryReplayStore, createProofOfWorkCaptcha, createThirdPartyCaptcha } from './captcha/index.ts';
import { createInfrastructureEgressGuard, createTenantEgressGuard, egressHttp } from './egress/index.ts';
import { createMmdbGeoIP } from './geoip/index.ts';
import { createExistingAccountGuardianVerifier, createManualGuardianVerifier, createMemoryGuardianStore } from './guardian/index.ts';
import { createKeyfileKeyProvider } from './kms/index.ts';
import { createSmtpMailer } from './mailer/index.ts';
import { createClamAvScanner } from './scan/index.ts';
import { createFilesystemStorage } from './storage/index.ts';

/**
 * WP-1.03 acceptance: an air-gapped install (`EGRESS_POLICY=none`) runs on its on-prem implementations without a
 * single connection or DNS lookup beyond the internal services, here the loopback stand-ins this test starts. The
 * container-backed half (Vault, S3 on SeaweedFS, Mailpit) is `test/egress-blocked.int.test.ts`.
 */
describe('egress-blocked run with the on-prem implementations', () => {
  const edition = loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none', EGRESS_ALLOWLIST: 'hooks.corp.local' });
  const infra = createInfrastructureEgressGuard(edition, ['127.0.0.1']);
  const tenant = createTenantEgressGuard(edition);
  let wire: EgressTripwire;
  let dir: string;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'form-airgap-'));
    wire = installEgressTripwire();
  });
  afterAll(async () => {
    wire.uninstall();
    for (const c of closers) await c();
    await rm(dir, { recursive: true, force: true });
  });

  it('is an air-gapped edition with no third-party feature', () => {
    expect(edition).toMatchObject({ airGapped: true, egressPolicy: 'none', captcha: { thirdParty: [] }, integrations: [], payments: [] });
  });

  it('wraps, unwraps and signs with the keyfile', async () => {
    const kms = createKeyfileKeyProvider({ masterKey: randomBytes(32) });
    const org = { orgId: randomUUID() };
    const { wrapped, kekRef } = await kms.wrap(randomBytes(32), org);
    await kms.unwrap(wrapped, kekRef, org);
    await kms.sign('audit-v1', utf8('checkpoint'));
  });

  it('stores and serves objects', async () => {
    const storage = createFilesystemStorage({ root: dir, publicUrl: 'http://127.0.0.1/_dev/storage', signingKey: randomBytes(32) });
    await storage.put('uploads', 'a/b', utf8('x'), { contentType: 'text/plain' });
    expect(await storage.head('uploads', 'a/b')).not.toBeNull();
  });

  it('sends mail through the internal relay', async () => {
    const sink = await startSmtpSink();
    closers.push(() => sink.close());
    const mailer = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, egress: infra });
    await mailer.send({ from: { address: 'noreply@corp.local' }, to: [{ address: 'owner@corp.local' }], subject: 's', text: 't' });
  });

  it('verifies proof of work locally, and refuses every third-party captcha', async () => {
    const pow = createProofOfWorkCaptcha({ hmacKey: randomBytes(32), challengeUrl: 'https://api.corp.local/c', replay: createMemoryReplayStore(), maxNumber: 300 });
    const ctx = { orgId: randomUUID(), formId: randomUUID() };
    expect((await pow.verify(solveAltcha(pow.challenge(ctx)), ctx)).ok).toBe(true);
    for (const provider of ['hcaptcha', 'turnstile', 'recaptcha_v3'] as const) {
      expect(() => createThirdPartyCaptcha({ provider, siteKey: 's', secret: 'x', egress: tenant, enabled: edition.captcha.thirdParty })).toThrow(/not enabled/);
    }
  });

  it('looks up countries in the bundled database', () => {
    const geo = createMmdbGeoIP(buildTestMmdb([{ network: '1.6.0.0/15', country: 'IN' }]));
    expect(geo.country('1.6.0.1')).toBe('IN');
  });

  it('scans with the in-cluster clamd', async () => {
    const clamd = await startFakeClamd();
    closers.push(() => clamd.close());
    const { stream } = trackedStream([eicarSample()]);
    expect((await createClamAvScanner({ host: clamd.host, port: clamd.port, egress: infra }).scan(stream, { fileId: 'f', bytes: 68 })).verdict).toBe('infected');
  });

  it('anchors checkpoints in the internal SIEM over syslog and OTLP', async () => {
    const syslog = await startSyslogReceiver();
    const otlp = await startOtlpLogReceiver();
    closers.push(syslog.close, otlp.close);
    await createSyslogAuditSink({ url: syslog.url, egress: infra }).forward(auditCheckpointFixture(1));
    await createOtlpAuditSink({ url: otlp.url, egress: infra }).forward(auditCheckpointFixture(2));
    expect((await syslog.received()).length + (await otlp.received()).length).toBe(2);
  });

  it('verifies guardians with the on-prem methods', async () => {
    const store = createMemoryGuardianStore();
    const manual = createManualGuardianVerifier({ store });
    const s = await manual.start({ orgId: 'o', submissionId: 's', guardianEmail: 'parent@corp.local' });
    expect((await manual.complete({ orgId: 'o', verificationId: s.verificationId, payload: { decision: 'approve', reviewerId: 'r' } })).verified).toBe(true);
    const existing = createExistingAccountGuardianVerifier({ store, accounts: { account: async () => undefined } });
    expect((await existing.start({ orgId: 'o', submissionId: 's2', guardianEmail: 'parent@corp.local' })).next).toBe('email_link');
  });

  it('refuses tenant destinations outside the allowlist before any lookup, and internal ones that resolve publicly', async () => {
    await expectPortError(egressHttp(tenant, new URL('https://hooks.example.com/x'), { method: 'POST', body: '{}' }), 'egress_denied');
    await expectPortError(egressHttp(tenant, new URL('https://203.0.113.10/x')), 'egress_denied');
    await expectPortError(infra.assertAllowed(new URL('https://kms.ap-south-1.amazonaws.com/')), 'egress_denied');
  });

  it('made no connection and no DNS lookup beyond loopback', () => {
    expect(wire.connections.length).toBeGreaterThan(0);
    expect(wire.violations()).toEqual([]);
  });
});
