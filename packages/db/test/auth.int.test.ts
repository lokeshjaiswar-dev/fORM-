import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audit,
  authCreateUser,
  authIdentityUser,
  authMfaTicket,
  authRecoveryCodeUse,
  authSession,
  authThrottleHit,
  authTokenPeek,
  authTokens,
  authTokenTake,
  authUserByEmail,
  authUserCredentials,
  PLATFORM_ORG_KEY,
  sessions,
  userIdentities,
  users,
  withTenant,
  withUser,
} from '../src/index.ts';
import { failure, pgCode, setupTestDb, type TestDb } from './harness.ts';

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(() => t?.close());

const sha = (s: string | Uint8Array) => new Uint8Array(createHash('sha256').update(s).digest());

async function newUser(over: Partial<{ email: string; passwordHash: string | null; verified: boolean }> = {}): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = over.email ?? `${id.slice(0, 8)}@auth.test`;
  const created = await authCreateUser(t.app.db, {
    id,
    email,
    emailNorm: email.toLowerCase(),
    name: 'Test',
    locale: 'en-IN',
    passwordHash: over.passwordHash === undefined ? '$argon2id$v=19$m=65536,t=3,p=1$x$y' : over.passwordHash,
    emailVerified: over.verified ?? true,
  });
  expect(created).toBe(true);
  return { id, email };
}

async function insertSession(userId: string, over: Partial<{ idle: string; absolute: string; lastSeen: string }> = {}): Promise<{ id: string; hash: Uint8Array }> {
  const id = randomUUID();
  const hash = sha(randomBytes(32));
  await t.owner.query(
    `insert into sessions (id, token_hash, user_id, mfa_level, last_seen_at, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, 'pwd', now() - $4::interval, now() + $5::interval, now() + $6::interval)`,
    [id, Buffer.from(hash), userId, over.lastSeen ?? '0 seconds', over.idle ?? '1 hour', over.absolute ?? '1 day'],
  );
  return { id, hash };
}

describe('auth definer functions (as fr_app, before any session)', () => {
  it('auth_create_user creates once per address and answers false for a taken one', async () => {
    const u = await newUser({ email: 'Mixed.Case@Auth.test' });
    expect(
      await authCreateUser(t.app.db, { id: randomUUID(), email: 'x', emailNorm: 'mixed.case@auth.test', name: null, locale: null, passwordHash: null, emailVerified: false }),
    ).toBe(false);
    const found = await authUserByEmail(t.app.db, 'mixed.case@auth.test');
    expect(found).toMatchObject({ id: u.id, email: 'Mixed.Case@Auth.test', status: 'active', totpEnabledAt: null });
    expect(found?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(pgCode(await failure(authCreateUser(t.app.db, { id: randomUUID(), email: 'A@b.c', emailNorm: 'A@b.c', name: null, locale: null, passwordHash: null, emailVerified: false })))).toBe('22023');
  });

  it('auth_user_by_email never returns the TOTP secret or recovery codes', async () => {
    const { rows } = await t.app.pool.query(`select * from auth_user_by_email('nobody@auth.test')`);
    expect(rows).toEqual([]);
    const { fields } = await t.app.pool.query(`select * from auth_user_by_email('x')`);
    expect(fields.map((f) => f.name)).not.toContain('totp_secret_enc');
    expect(fields.map((f) => f.name)).not.toContain('recovery_code_hashes');
  });

  it('keeps credential columns and token hashes unreadable for fr_app, also for the user themselves', async () => {
    const u = await newUser();
    const s = await insertSession(u.id);
    expect(s.id).toBeDefined();
    for (const q of [sql`select password_hash from users`, sql`select totp_secret_enc from users`, sql`select token_hash from sessions`, sql`select ip_hash from sessions`, sql`select token_hash from auth_tokens`]) {
      const err = await failure(withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) => tx.execute(q)));
      expect(pgCode(err)).toBe('42501');
    }
  });

  it('auth_session reports the state and slides the idle expiry of an active session at most once a minute', async () => {
    const u = await newUser();
    const fresh = await insertSession(u.id);
    const first = await authSession(t.app.db, fresh.hash, 43_200);
    expect(first).toMatchObject({ sessionId: fresh.id, userId: u.id, state: 'active', mfaLevel: 'pwd' });

    const stale = await insertSession(u.id, { lastSeen: '5 minutes', idle: '10 minutes' });
    const slid = await authSession(t.app.db, stale.hash, 43_200);
    expect(slid!.idleExpiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    // Never past the absolute expiry.
    const capped = await insertSession(u.id, { lastSeen: '5 minutes', idle: '1 minute', absolute: '2 hours' });
    const c = await authSession(t.app.db, capped.hash, 43_200);
    expect(c!.idleExpiresAt.getTime()).toBe(c!.absoluteExpiresAt.getTime());

    const idle = await insertSession(u.id, { idle: '-1 second' });
    expect((await authSession(t.app.db, idle.hash, 43_200))?.state).toBe('expired');
    const revoked = await insertSession(u.id);
    await t.owner.query(`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1`, [revoked.id]);
    expect((await authSession(t.app.db, revoked.hash, 43_200))?.state).toBe('revoked');
    expect(await authSession(t.app.db, sha('unknown'), 43_200)).toBeNull();
    await t.owner.query(`update users set status = 'disabled' where id = $1`, [u.id]);
    expect((await authSession(t.app.db, fresh.hash, 43_200))?.state).toBe('user_inactive');
    expect(pgCode(await failure(authSession(t.app.db, fresh.hash, 5)))).toBe('22023');
  });

  it('auth_token_take redeems a token once, for its purpose, before it expires', async () => {
    const u = await newUser();
    const token = sha('magic-1');
    await withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) =>
      tx.insert(authTokens).values({ id: randomUUID(), tokenHash: token, purpose: 'magic_link', userId: u.id, data: { next: '/forms' }, expiresAt: new Date(Date.now() + 60_000) }),
    );
    expect(await authTokenTake(t.app.db, token, 'password_reset')).toBeNull();
    expect(await authTokenTake(t.app.db, token, 'magic_link')).toEqual({ userId: u.id, data: { next: '/forms' } });
    expect(await authTokenTake(t.app.db, token, 'magic_link')).toBeNull();

    const expired = sha('magic-2');
    await t.owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values ($1, $2, 'magic_link', $3, now() - interval '1 second')`, [
      randomUUID(),
      Buffer.from(expired),
      u.id,
    ]);
    expect(await authTokenTake(t.app.db, expired, 'magic_link')).toBeNull();
  });

  it('auth_token_peek names the account of a live link without using it up, for email links only', async () => {
    const u = await newUser({ verified: false });
    const token = sha('peek-1');
    await withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) =>
      tx.insert(authTokens).values({ id: randomUUID(), tokenHash: token, purpose: 'verify_email', userId: u.id, expiresAt: new Date(Date.now() + 60_000) }),
    );
    const peeked = { userId: u.id, email: u.email, emailVerified: false, hasPassword: true };
    expect(await authTokenPeek(t.app.db, token, 'verify_email')).toEqual(peeked);
    expect(await authTokenPeek(t.app.db, token, 'verify_email')).toEqual(peeked);
    expect(await authTokenPeek(t.app.db, token, 'magic_link')).toBeNull();
    const ticket = sha('peek-ticket');
    await t.owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, expires_at) values ($1, $2, 'mfa', $3, now() + interval '5 minutes')`, [randomUUID(), Buffer.from(ticket), u.id]);
    expect(await authTokenPeek(t.app.db, ticket, 'mfa' as 'magic_link')).toBeNull();
    expect(await authTokenTake(t.app.db, token, 'verify_email')).not.toBeNull();
    expect(await authTokenPeek(t.app.db, token, 'verify_email')).toBeNull();
  });

  it('keeps a revoked session revoked and a used token used, for every role', async () => {
    const u = await newUser();
    const s = await insertSession(u.id);
    const token = sha('once-1');
    await withUser(t.app.db, { userId: u.id, requestId: 'r' }, async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'logout' }).where(eq(sessions.id, s.id));
      await tx.insert(authTokens).values({ id: randomUUID(), tokenHash: token, purpose: 'magic_link', userId: u.id, expiresAt: new Date(Date.now() + 60_000) });
    });
    expect(await authTokenTake(t.app.db, token, 'magic_link')).not.toBeNull();
    for (const set of [{ revokedAt: null }, { revokedAt: new Date(Date.now() + 1000) }, { revokedReason: 'rotated' as const }]) {
      const err = await failure(withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) => tx.update(sessions).set(set).where(eq(sessions.id, s.id))));
      expect(pgCode(err)).toBe('42501');
    }
    const reopen = await failure(withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) => tx.update(authTokens).set({ consumedAt: null }).where(eq(authTokens.userId, u.id))));
    expect(pgCode(reopen)).toBe('42501');
    expect(pgCode(await failure(t.owner.query(`update sessions set revoked_at = null where id = $1`, [s.id])))).toBe('42501');
    expect(pgCode(await failure(t.owner.query(`update auth_tokens set consumed_at = null where user_id = $1`, [u.id])))).toBe('42501');
    expect((await authSession(t.app.db, s.hash, 43_200))?.state).toBe('revoked');
  });

  it('auth_mfa_ticket allows five attempts per ticket', async () => {
    const u = await newUser();
    const ticket = sha('ticket');
    await t.owner.query(`insert into auth_tokens (id, token_hash, purpose, user_id, data, expires_at) values ($1, $2, 'mfa', $3, '{"factor":"pwd"}', now() + interval '5 minutes')`, [
      randomUUID(),
      Buffer.from(ticket),
      u.id,
    ]);
    for (let i = 1; i <= 5; i++) expect(await authMfaTicket(t.app.db, ticket)).toEqual({ userId: u.id, data: { factor: 'pwd' }, attempts: i });
    expect(await authMfaTicket(t.app.db, ticket)).toBeNull();
  });

  it('auth_recovery_code_use removes a matching code once and only while TOTP is on', async () => {
    const u = await newUser();
    await t.owner.query(`update users set recovery_code_hashes = array['a', 'b', 'c'] where id = $1`, [u.id]);
    expect(await authRecoveryCodeUse(t.app.db, u.id, 'a')).toBeNull();
    await t.owner.query(`update users set totp_enabled_at = now() where id = $1`, [u.id]);
    expect(await authRecoveryCodeUse(t.app.db, u.id, 'b')).toBe(2);
    expect(await authRecoveryCodeUse(t.app.db, u.id, 'b')).toBeNull();
    expect(await authRecoveryCodeUse(t.app.db, randomUUID(), 'a')).toBeNull();
    expect((await authUserCredentials(t.app.db, u.id))?.recoveryCodesLeft).toBe(2);
  });

  it('auth_identity_user finds the user an OAuth account is linked to', async () => {
    const u = await newUser({ passwordHash: null });
    await withUser(t.app.db, { userId: u.id, requestId: 'r' }, (tx) => tx.insert(userIdentities).values({ id: randomUUID(), userId: u.id, provider: 'google', subject: 'g-123' }));
    expect(await authIdentityUser(t.app.db, 'google', 'g-123')).toBe(u.id);
    expect(await authIdentityUser(t.app.db, 'microsoft', 'g-123')).toBeNull();
  });

  it('auth_throttle_hit counts per bucket, key and window', async () => {
    const key = sha(randomUUID());
    expect((await authThrottleHit(t.app.db, 'auth_login', key, 900)).hits).toBe(1);
    const second = await authThrottleHit(t.app.db, 'auth_login', key, 900);
    expect(second.hits).toBe(2);
    expect(second.windowEnds.getTime()).toBeGreaterThan(Date.now());
    expect((await authThrottleHit(t.app.db, 'auth_any', key, 900)).hits).toBe(1);
    expect(pgCode(await failure(t.app.db.execute(sql`select * from auth_throttle_hit('evil', ${Buffer.from(key)}, 60)`)))).toBe('22023');
  });
});

describe('withUser', () => {
  it('lets a user write their own identity rows and credential columns, nobody else’s', async () => {
    const me = await newUser();
    const other = await newUser();
    await withUser(t.app.db, { userId: me.id, requestId: 'r' }, async (tx) => {
      await tx.insert(sessions).values({
        id: randomUUID(),
        tokenHash: sha(randomBytes(8)),
        userId: me.id,
        mfaLevel: 'pwd+totp',
        idleExpiresAt: new Date(Date.now() + 3600_000),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      });
      const mine = await tx.update(users).set({ lastLoginAt: new Date(), totpLastStep: 42 }).where(eq(users.id, me.id)).returning({ id: users.id });
      expect(mine).toEqual([{ id: me.id }]);
      const theirs = await tx.update(users).set({ passwordHash: 'x' }).where(eq(users.id, other.id)).returning({ id: users.id });
      expect(theirs).toEqual([]);
      expect(await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, other.id))).toEqual([]);
    });
    const err = await failure(
      withUser(t.app.db, { userId: me.id, requestId: 'r' }, (tx) =>
        tx.insert(sessions).values({
          id: randomUUID(),
          tokenHash: sha(randomBytes(8)),
          userId: other.id,
          mfaLevel: 'pwd',
          idleExpiresAt: new Date(Date.now() + 3600_000),
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    );
    expect(pgCode(err)).toBe('42501');
    expect((await authUserCredentials(t.app.db, me.id))?.totpLastStep).toBe(42);
  });

  it('changes credential columns only outside an org context', async () => {
    const me = await newUser();
    const tenant = { orgId: randomUUID(), actor: 'user' as const, userId: me.id, perms: [], teamIds: [], requestId: 'r' };
    for (const set of [{ totpEnabledAt: new Date() }, { passwordHash: null }, { emailVerifiedAt: null }, { recoveryCodeHashes: ['x'] }, { totpLastStep: 7 }]) {
      const err = await failure(withTenant(t.app.db, tenant, (tx) => tx.update(users).set(set).where(eq(users.id, me.id))));
      expect(pgCode(err)).toBe('42501');
    }
    const renamed = await withTenant(t.app.db, tenant, (tx) => tx.update(users).set({ name: 'Renamed', lastLoginAt: new Date() }).where(eq(users.id, me.id)).returning({ id: users.id }));
    expect(renamed).toEqual([{ id: me.id }]);
  });

  it('files audit records under the platform chain', async () => {
    const me = await newUser();
    await withUser(t.app.db, { userId: me.id, requestId: 'r' }, (tx) =>
      audit.append(tx, PLATFORM_ORG_KEY, { actorKind: 'user', actorId: me.id, action: 'auth.logout', resourceType: 'session', resourceId: randomUUID(), outcome: 'success' }),
    );
    const { rows } = await t.owner.query(`select org_key from audit_pending where event->>'actorId' = $1`, [me.id]);
    expect(rows).toEqual([{ org_key: PLATFORM_ORG_KEY }]);
  });

  it('refuses a malformed user id before any SQL runs', async () => {
    await expect(withUser(t.app.db, { userId: 'nope', requestId: 'r' }, async () => 1)).rejects.toThrow(TypeError);
  });
});
