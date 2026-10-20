import { PortError, type AuditCheckpoint } from '@form/ports';
import { hasControlChars } from '../text.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Every sink checks a checkpoint before it anchors it, so nothing malformed reaches a WORM bucket or a SIEM. */
export function checkCheckpoint(cp: AuditCheckpoint): AuditCheckpoint {
  const bad = (what: string) => new PortError('invalid_argument', `audit checkpoint: ${what}`);
  if (!UUID.test(cp.orgKey)) throw bad('orgKey must be a lower-case uuid');
  if (!Number.isSafeInteger(cp.seq) || cp.seq < 1) throw bad('seq must be a positive integer');
  if (!HASH.test(cp.hash)) throw bad('hash must be 64 lower-case hex digits');
  if (Number.isNaN(Date.parse(cp.signedAt))) throw bad('signedAt must be an instant');
  if (cp.keyId.length === 0 || cp.keyId.length > 128 || hasControlChars(cp.keyId)) throw bad('invalid keyId');
  if (cp.alg !== 'ed25519' && cp.alg !== 'es256') throw bad(`unknown alg ${JSON.stringify(cp.alg)}`);
  if (!B64URL.test(cp.signature)) throw bad('signature must be base64url');
  if (cp.anchoredObject !== undefined && hasControlChars(cp.anchoredObject)) throw bad('invalid anchoredObject');
  return cp;
}
