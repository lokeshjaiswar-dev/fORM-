import { randomUUID } from 'node:crypto';
import type {} from '@fastify/cookie';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { audit, PLATFORM_ORG_KEY, sessions, type MfaLevel, type SessionRevokeReason, type Tx } from '@form/db';
import { hex, randomToken, tokenHash } from './crypto.ts';

/** `__Host-`: Secure, Path=/, no Domain, so no sibling host can set or overwrite it (architecture §3.2). */
export const SESSION_COOKIE = '__Host-fr_sess';
export const SESSION_IDLE_SECONDS = 12 * 3600;
export const SESSION_ABSOLUTE_SECONDS = 14 * 86_400;

export interface ClientInfo {
  ipHash: Uint8Array;
  ua: string | null;
  requestId: string;
}

export interface IssuedSession {
  id: string;
  token: string;
  mfaLevel: MfaLevel;
  absoluteExpiresAt: Date;
}

const uaSummary = (ua: string | null) => (ua ? ua.slice(0, 200) : null);

/** A new session with a fresh token: every sign-in and every privilege change gets one, so a planted token is useless. */
export async function issueSession(
  tx: Tx,
  o: { userId: string; mfaLevel: MfaLevel; client: ClientInfo; activeOrgId?: string | null; now: Date },
): Promise<IssuedSession> {
  const token = randomToken();
  const id = randomUUID();
  const absoluteExpiresAt = new Date(o.now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
  const idleExpiresAt = new Date(Math.min(o.now.getTime() + SESSION_IDLE_SECONDS * 1000, absoluteExpiresAt.getTime()));
  await tx.insert(sessions).values({
    id,
    tokenHash: tokenHash(token),
    userId: o.userId,
    activeOrgId: o.activeOrgId ?? null,
    mfaLevel: o.mfaLevel,
    ipHash: o.client.ipHash,
    uaSummary: uaSummary(o.client.ua),
    createdAt: o.now,
    lastSeenAt: o.now,
    idleExpiresAt,
    absoluteExpiresAt,
  });
  return { id, token, mfaLevel: o.mfaLevel, absoluteExpiresAt };
}

export async function revokeSession(tx: Tx, id: string, reason: SessionRevokeReason, now: Date): Promise<boolean> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Every live session of the user (RLS scopes the update to them) except `keep`. */
export async function revokeOtherSessions(tx: Tx, keep: string | null, reason: SessionRevokeReason, now: Date): Promise<string[]> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(keep ? and(isNull(sessions.revokedAt), ne(sessions.id, keep)) : isNull(sessions.revokedAt))
    .returning({ id: sessions.id });
  return rows.map((r) => r.id);
}

/**
 * Rotation on a privilege change (a second factor added or removed): a new token at the new level, the old one
 * revoked, both in the caller's transaction and audited there.
 */
export async function rotateSession(
  tx: Tx,
  o: { userId: string; oldSessionId: string; mfaLevel: MfaLevel; client: ClientInfo; activeOrgId: string | null; now: Date },
): Promise<IssuedSession> {
  await revokeSession(tx, o.oldSessionId, 'rotated', o.now);
  const next = await issueSession(tx, o);
  await audit.append(tx, PLATFORM_ORG_KEY, {
    actorKind: 'user',
    actorId: o.userId,
    sessionId: next.id,
    actorIpHash: hex(o.client.ipHash),
    actorUa: o.client.ua,
    action: 'auth.session_rotated',
    resourceType: 'session',
    resourceId: next.id,
    outcome: 'success',
    requestId: o.client.requestId,
    metadata: { previousSessionId: o.oldSessionId, mfaLevel: o.mfaLevel },
  });
  return next;
}

export function setSessionCookie(reply: FastifyReply, s: Pick<IssuedSession, 'token' | 'absoluteExpiresAt'>): void {
  reply.setCookie(SESSION_COOKIE, s.token, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', expires: s.absoluteExpiresAt });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
}
