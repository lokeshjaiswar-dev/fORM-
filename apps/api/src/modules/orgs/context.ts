import type { FastifyRequest } from 'fastify';
import type { Db } from '@form/db';
import { clientInfo } from '../../auth.ts';
import type { ApiConfig } from '../../config.ts';
import { hex } from '../auth/crypto.ts';
import type { AuthMailer } from '../auth/mail.ts';

export interface OrgModuleDeps {
  db: Db;
  auditDb: Db;
  config: ApiConfig;
  /** The auth module's mailer: invites go after commit, in the background, like sign-in links. */
  mail: AuthMailer;
  now: () => Date;
}

/** What audit records say about the client: a keyed hash of the IP (hex) and the user agent. */
export function clientOf(c: OrgModuleDeps, request: FastifyRequest): { ipHash: string; ua: string | null } {
  const cl = clientInfo(request, c.config.auth.secret, c.now());
  return { ipHash: hex(cl.ipHash), ua: cl.ua };
}

/** The SQLSTATE and constraint of a pg error, also when drizzle wraps it. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
  }
  return {};
}

export const isLastOwnerError = (err: unknown) => pgError(err).constraint === 'memberships_last_owner';
