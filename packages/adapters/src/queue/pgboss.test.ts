import { randomBytes } from 'node:crypto';
import { isPortError } from '@form/ports';
import { describe, expect, it } from 'vitest';
import { parseJobKeyring } from './envelope.ts';
import { createPgBossQueue, deadLetterQueue, installQueueSchema } from './pgboss.ts';

// Nothing here connects: every check runs before pg-boss opens its pool. The queue itself is covered by the
// worker's integration tests against Postgres (apps/worker/test); its port contract suite is WP-1.03 (BL-014).
const keyring = parseJobKeyring(`k:${randomBytes(32).toString('base64url')}`);
const connectionString = 'postgres://fr_app:pw@127.0.0.1:1/form';

async function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (isPortError(e) ? e.code : String(e)),
  );
}

describe('createPgBossQueue', () => {
  it('names dead-letter queues after their queue', () => {
    expect(deadLetterQueue('email.send')).toBe('email.send.dead');
  });

  it('refuses to work jobs as a producer, or without the ADR-0016 guards', async () => {
    const producer = createPgBossQueue({ connectionString, keyring, mode: 'producer' });
    expect(await code(producer.work('system.heartbeat', async () => {}))).toBe('unsupported');
    const unguarded = createPgBossQueue({ connectionString, keyring, mode: 'worker', resolveOrg: async () => null });
    expect(await code(unguarded.work('system.heartbeat', async () => {}))).toBe('unsupported');
  });

  it('refuses unsafe schema and role names', async () => {
    expect(() => createPgBossQueue({ connectionString, keyring, mode: 'producer', schema: 'pgboss; drop' })).toThrow(/invalid queue schema/);
    expect(await code(installQueueSchema({ connectionString, appRole: 'fr_app to public' }))).toBe('invalid_argument');
    expect(await code(installQueueSchema({ connectionString, appRole: 'fr_app', schema: 'Bad-Schema' }))).toBe('invalid_argument');
  });

  it('signs before sending, so a request outside its scope never reaches the database', async () => {
    const producer = createPgBossQueue({ connectionString, keyring, mode: 'producer' });
    expect(await code(producer.send('partitions.maintain', { orgId: '0197a1b2-0000-7000-8000-000000000001' as never, resource: { type: 'system', id: 'x' }, data: {} }))).toBe(
      'invalid_argument',
    );
  });
});
