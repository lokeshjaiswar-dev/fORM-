import { sql } from 'drizzle-orm';
import type { Db, Executor, Tx } from './client.ts';
import type { AuthTokenPurpose, MfaLevel, OAuthProvider } from './schema/index.ts';
import { isUuid } from './tenant.ts';

/** Typed calls of the auth definer functions (migration 0006, ADR-0017) and the user context they lead to. */

export interface UserCtx {
  userId: string;
  requestId: string;
}

/**
 * Runs `fn` as the user, outside any org: identity rows (sessions, linked accounts, auth tokens, the user's own
 * credential columns) are the user's, not an org's. Audit records written here go to the platform chain.
 * Only after the user is proven: a session, a verified first factor, a redeemed email token.
 */
export async function withUser<T>(db: Db, ctx: UserCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(ctx.userId)) throw new TypeError('withUser: userId must be a uuid');
  if (typeof ctx.requestId !== 'string' || ctx.requestId.length === 0 || ctx.requestId.length > 128) throw new TypeError('withUser: requestId is required');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.org_id', '', true),
      set_config('app.user_id', ${ctx.userId}, true),
      set_config('app.team_ids', '{}', true),
      set_config('app.perms', '{}', true),
      set_config('app.actor_kind', 'user', true),
      set_config('app.subject_ids', '{}', true),
      set_config('app.request_id', ${ctx.requestId}, true)`);
    return fn(tx);
  });
}

export type UserStatus = 'active' | 'disabled' | 'deleted';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  totpEnabledAt: Date | null;
}

export interface AuthCredentials extends AuthUser {
  totpSecretEnc: unknown;
  totpLastStep: number | null;
  recoveryCodesLeft: number;
}

/** Raw `execute()` rows carry timestamps as strings. */
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  email_verified_at: string | null;
  password_hash: string | null;
  totp_enabled_at: string | null;
};

const date = (v: string | Date) => new Date(v);
const dateOrNull = (v: string | Date | null) => (v === null ? null : new Date(v));

const toUser = (r: UserRow): AuthUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  status: r.status,
  emailVerifiedAt: dateOrNull(r.email_verified_at),
  passwordHash: r.password_hash,
  totpEnabledAt: dateOrNull(r.totp_enabled_at),
});

export async function authUserByEmail(db: Executor, emailNorm: string): Promise<AuthUser | null> {
  const { rows } = await db.execute<UserRow>(sql`select * from auth_user_by_email(${emailNorm})`);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function authUserCredentials(db: Executor, userId: string): Promise<AuthCredentials | null> {
  const { rows } = await db.execute<UserRow & { totp_secret_enc: unknown; totp_last_step: string | null; recovery_codes_left: number }>(
    sql`select * from auth_user_credentials(${userId}::uuid)`,
  );
  const r = rows[0];
  if (!r) return null;
  return { ...toUser(r), totpSecretEnc: r.totp_secret_enc, totpLastStep: r.totp_last_step === null ? null : Number(r.totp_last_step), recoveryCodesLeft: r.recovery_codes_left };
}

export interface NewAuthUser {
  id: string;
  email: string;
  emailNorm: string;
  name: string | null;
  locale: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
}

/** False when the address is already taken. */
export async function authCreateUser(db: Executor, u: NewAuthUser): Promise<boolean> {
  const { rows } = await db.execute<{ created: boolean }>(
    sql`select auth_create_user(${u.id}::uuid, ${u.email}, ${u.emailNorm}, ${u.name}, ${u.locale}, ${u.passwordHash}, ${u.emailVerified}) as created`,
  );
  return rows[0]?.created === true;
}

/** The codes left after using one, or null when the code is not one of the user's. */
export async function authRecoveryCodeUse(db: Executor, userId: string, codeHash: string): Promise<number | null> {
  const { rows } = await db.execute<{ codes_left: number | null }>(sql`select auth_recovery_code_use(${userId}::uuid, ${codeHash}) as codes_left`);
  return rows[0]?.codes_left ?? null;
}

export async function authIdentityUser(db: Executor, provider: OAuthProvider, subject: string): Promise<string | null> {
  const { rows } = await db.execute<{ user_id: string | null }>(sql`select auth_identity_user(${provider}, ${subject}) as user_id`);
  return rows[0]?.user_id ?? null;
}

export interface TakenToken {
  userId: string;
  data: Record<string, unknown>;
}

/** Redeems a single-use token; null when unknown, used, expired or for another purpose. */
export async function authTokenTake(db: Executor, tokenHash: Uint8Array, purpose: AuthTokenPurpose): Promise<TakenToken | null> {
  const { rows } = await db.execute<{ user_id: string; data: Record<string, unknown> }>(
    sql`select * from auth_token_take(${Buffer.from(tokenHash)}, ${purpose})`,
  );
  return rows[0] ? { userId: rows[0].user_id, data: rows[0].data } : null;
}

export interface PeekedToken {
  userId: string;
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

/** The account a live verification or sign-in link is for, without redeeming it; null when it would not redeem. */
export async function authTokenPeek(db: Executor, tokenHash: Uint8Array, purpose: 'verify_email' | 'magic_link'): Promise<PeekedToken | null> {
  const { rows } = await db.execute<{ user_id: string; email: string; email_verified: boolean; has_password: boolean }>(
    sql`select * from auth_token_peek(${Buffer.from(tokenHash)}, ${purpose})`,
  );
  const r = rows[0];
  return r ? { userId: r.user_id, email: r.email, emailVerified: r.email_verified, hasPassword: r.has_password } : null;
}

/** Counts one attempt at an MFA ticket; null when the ticket is unknown, used, expired or out of attempts. */
export async function authMfaTicket(db: Executor, tokenHash: Uint8Array): Promise<(TakenToken & { attempts: number }) | null> {
  const { rows } = await db.execute<{ user_id: string; data: Record<string, unknown>; attempts: number }>(
    sql`select * from auth_mfa_ticket(${Buffer.from(tokenHash)})`,
  );
  return rows[0] ? { userId: rows[0].user_id, data: rows[0].data, attempts: rows[0].attempts } : null;
}

export type SessionState = 'active' | 'revoked' | 'expired' | 'user_inactive';

export interface SessionLookup {
  sessionId: string;
  userId: string;
  state: SessionState;
  mfaLevel: MfaLevel;
  activeOrgId: string | null;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/** The session behind a cookie token hash (any state), sliding the idle expiry of an active one. */
export async function authSession(db: Executor, tokenHash: Uint8Array, idleSeconds: number): Promise<SessionLookup | null> {
  const { rows } = await db.execute<{
    session_id: string;
    user_id: string;
    state: SessionState;
    mfa_level: MfaLevel;
    active_org_id: string | null;
    created_at: string;
    idle_expires_at: string;
    absolute_expires_at: string;
  }>(sql`select * from auth_session(${Buffer.from(tokenHash)}, ${idleSeconds}::integer)`);
  const r = rows[0];
  if (!r) return null;
  return {
    sessionId: r.session_id,
    userId: r.user_id,
    state: r.state,
    mfaLevel: r.mfa_level,
    activeOrgId: r.active_org_id,
    createdAt: date(r.created_at),
    idleExpiresAt: date(r.idle_expires_at),
    absoluteExpiresAt: date(r.absolute_expires_at),
  };
}

export const AUTH_THROTTLE_BUCKETS = ['auth_any', 'auth_login', 'auth_account', 'auth_mfa', 'auth_mail'] as const;
export type AuthThrottleBucket = (typeof AUTH_THROTTLE_BUCKETS)[number];

/** One hit in the bucket's current window: the window's total so far and when it ends. */
export async function authThrottleHit(
  db: Executor,
  bucket: AuthThrottleBucket,
  key: Uint8Array,
  windowSeconds: number,
): Promise<{ hits: number; windowEnds: Date }> {
  const { rows } = await db.execute<{ hits: number; window_ends: string }>(
    sql`select * from auth_throttle_hit(${bucket}, ${Buffer.from(key)}, ${windowSeconds}::integer)`,
  );
  return { hits: rows[0]!.hits, windowEnds: date(rows[0]!.window_ends) };
}
