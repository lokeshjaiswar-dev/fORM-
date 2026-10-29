import { PortError } from '@form/ports';
import { isUuid, type TenantRunner } from '../sql.ts';

/** Remembers redeemed proof-of-work challenges until they expire, so one solution cannot pass twice. */
export interface CaptchaReplayStore {
  /** Records the challenge as redeemed; false when it already was. */
  redeem(orgId: string, challengeHash: Uint8Array, expiresAt: Date): Promise<boolean>;
}

/** One process only: replicas do not share it. For tests and single-process demos. */
export function createMemoryReplayStore(o: { now?: () => number } = {}): CaptchaReplayStore {
  const now = o.now ?? Date.now;
  const redeemed = new Map<string, number>();
  return {
    async redeem(orgId, hash, expiresAt) {
      const t = now();
      for (const [k, exp] of redeemed) if (exp <= t) redeemed.delete(k);
      const key = `${orgId}|${Buffer.from(hash).toString('hex')}`;
      if (redeemed.has(key)) return false;
      redeemed.set(key, expiresAt.getTime());
      return true;
    },
  };
}

export interface PostgresReplayStore extends CaptchaReplayStore {
  /** Deletes the org's expired redemptions and returns how many; nothing calls it until WP-1.13 (BL-258). */
  purgeExpired(orgId: string): Promise<number>;
}

/** `captcha_redemptions` (migration 0010), under RLS: every replica sees every redemption of the org. */
export function createPostgresReplayStore(o: { inTenant: TenantRunner }): PostgresReplayStore {
  const checkOrg = (orgId: string) => {
    if (!isUuid(orgId)) throw new PortError('invalid_argument', 'orgId must be a uuid');
  };
  return {
    async redeem(orgId, hash, expiresAt) {
      checkOrg(orgId);
      if (Number.isNaN(expiresAt.getTime())) throw new PortError('invalid_argument', 'expiresAt must be a valid date');
      const { rows } = await o.inTenant(orgId, (sql) =>
        sql.executeSql(
          'insert into captcha_redemptions (org_id, challenge_hash, expires_at) values ($1, $2, $3) on conflict (org_id, challenge_hash) do nothing returning 1 as redeemed',
          [orgId, Buffer.from(hash), expiresAt.toISOString()],
        ),
      );
      return rows.length === 1;
    },
    async purgeExpired(orgId) {
      checkOrg(orgId);
      const { rows } = await o.inTenant(orgId, (sql) => sql.executeSql('delete from captcha_redemptions where expires_at < now() returning 1'));
      return rows.length;
    },
  };
}
