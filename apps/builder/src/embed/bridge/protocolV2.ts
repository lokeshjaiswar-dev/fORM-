import { BRIDGE_V2, BRIDGE_V2_CHILD_TYPES, BRIDGE_V2_PARENT_TYPES, FpBridgeV2MessageSchema, type FpBridgeV2Message } from '@/embed/contract';

/*
 * fp-bridge/2 (SEC-DESIGN 3.4, DESIGN 3.7), child side. The closed schemas are the contract's (`FpBridgeV2MessageSchema`,
 * canonical in embed/contract and replayed by classic's copy of the fixtures); this file only says which direction a type may
 * travel and parses without throwing. Every message is a closed object, so no message has a field that could hold a bearer.
 * `state` never carries values, and `collected` is the only message that does.
 */

export const PROTOCOL_V2 = BRIDGE_V2;

type OfTypes<T extends FpBridgeV2Message['type']> = Extract<FpBridgeV2Message, { type: T }>;
export type ParentMessage = OfTypes<(typeof BRIDGE_V2_PARENT_TYPES)[number]>;
export type ChildMessage = OfTypes<(typeof BRIDGE_V2_CHILD_TYPES)[number]>;
export type ParentType = ParentMessage['type'];
export type ChildType = ChildMessage['type'];
export type PortMessage = OfTypes<'port'>;
export type HelloMessage = OfTypes<'hello'>;
/** A child message before the transport stamps `protocol` on it. */
export type ChildBody = ChildMessage extends infer M ? (M extends unknown ? Omit<M, 'protocol'> : never) : never;
export type InitMessage = OfTypes<'init'>;
export type BridgeElementOfInit = InitMessage['doctypeFields'][number];

export const isParentType = (type: unknown): type is ParentType => typeof type === 'string' && (BRIDGE_V2_PARENT_TYPES as readonly string[]).includes(type);
export const isChildType = (type: unknown): type is ChildType => typeof type === 'string' && (BRIDGE_V2_CHILD_TYPES as readonly string[]).includes(type);

export type ParseV2 =
  | { ok: true; message: FpBridgeV2Message }
  /** `foreign`: not an fp-bridge envelope. `protocol`: another version (/1 is retired). `invalid`: right protocol, wrong shape. */
  | { ok: false; reason: 'foreign' | 'protocol' | 'invalid'; detail?: string };

/** Schema-checks one received value. Never throws. */
export function parseV2(raw: unknown): ParseV2 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'foreign' };
  const head = raw as { protocol?: unknown };
  if (typeof head.protocol !== 'string' || !head.protocol.startsWith('fp-bridge/')) return { ok: false, reason: 'foreign' };
  if (head.protocol !== PROTOCOL_V2) return { ok: false, reason: 'protocol', detail: head.protocol.slice(0, 40) };
  const parsed = FpBridgeV2MessageSchema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: 'invalid', detail: issue ? `${issue.path.join('.') || '(message)'}: ${issue.message}`.slice(0, 200) : 'invalid' };
}

/** A message the parent may send on the port (anything else on the port is dropped). */
export function parseParentMessage(raw: unknown): { ok: true; message: ParentMessage } | { ok: false; reason: ParseV2Reason } {
  const parsed = parseV2(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!isParentType(parsed.message.type)) return { ok: false, reason: 'direction' };
  return { ok: true, message: parsed.message as ParentMessage };
}

export type ParseV2Reason = 'foreign' | 'protocol' | 'invalid' | 'direction';

/** `msg` with `protocol` stamped, checked against the schema and the child direction (a bug here throws: nothing invalid ever leaves the page). */
export function stampChild(body: ChildBody): ChildMessage {
  const message = { protocol: PROTOCOL_V2, ...body };
  const parsed = parseV2(message);
  if (!parsed.ok || !isChildType(parsed.message.type)) throw new Error(`fp-bridge/2: refusing to send an invalid ${String((body as { type: unknown }).type)} message`);
  return parsed.message as ChildMessage;
}

/*
 * The prefill hash: a consistency marker, not a secret. The child puts it in every `collected`; the parent computes the same
 * value from the `init` it sent and drops an answer that was made from another one (a stale child after a re-init). 64-bit
 * FNV-1a over the canonical JSON `{v: [[id, value|null]...sorted by lower-case id], m: [masked ids sorted, lower-case]}`, as 16 hex
 * characters. A secret value never enters it (init.values holds null for a masked one). Classic's `bridgeProtocolV2.ts` has
 * the same function and a test pins both to the same golden vector.
 */
export function prefillHash(values: Readonly<Record<string, string | null>>, masked: readonly string[]): string {
  const v = Object.entries(values)
    .map(([id, value]) => [id.toLowerCase(), value] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const m = masked.map((id) => id.toLowerCase()).sort();
  const bytes = new TextEncoder().encode(JSON.stringify({ v, m }));
  let h = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
