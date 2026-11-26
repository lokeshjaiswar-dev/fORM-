import { describe, expect, it } from 'vitest';
import raw from '@/embed/contract/__fixtures__/fp-bridge-v2.fixtures.json' with { type: 'json' };
import { BRIDGE_V2_CHILD_TYPES, BRIDGE_V2_PARENT_TYPES, BRIDGE_V2_WINDOW_TYPES } from '@/embed/contract';
import { PROTOCOL_V2, isChildType, isParentType, parseParentMessage, parseV2, prefillHash, stampChild, type ChildBody } from './protocolV2.ts';

/* T-62 (SEC-DESIGN 10.3): fp-bridge/2 closed schemas, replayed from the contract fixtures; direction rules; the prefill hash. */

interface Case { name: string; input: unknown; expect: { valid: boolean; why?: string }; via: 'window' | 'port'; dir?: 'child->parent' | 'parent->child' }
const cases = (raw as unknown as { cases: Case[] }).cases;

describe('every fixture case, as the child reads it (T-62)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const parsed = parseV2(c.input);
    expect(parsed.ok, c.expect.why ?? '').toBe(c.expect.valid);
  });

  it('covers every message type of the contract in both directions', () => {
    const seen = new Set(cases.filter((c) => c.expect.valid).map((c) => (c.input as { type: string }).type));
    for (const type of [...BRIDGE_V2_WINDOW_TYPES, ...BRIDGE_V2_CHILD_TYPES, ...BRIDGE_V2_PARENT_TYPES]) expect(seen.has(type), type).toBe(true);
  });

  it('the protocol constant is the fixtures\'', () => {
    expect(PROTOCOL_V2).toBe((raw as unknown as { protocol: string }).protocol);
  });
});

describe('state never carries values (E2)', () => {
  const state = { protocol: PROTOCOL_V2, type: 'state', dialogId: 'dlg-1', valid: true, dirty: true, touched: [] };
  it('a state message with a values key is invalid, so no value can leave while the person types', () => {
    expect(parseV2(state).ok).toBe(true);
    expect(parseV2({ ...state, values: { 'c2000000-0000-4000-8000-000000000101': 'x' } }).ok).toBe(false);
  });
  it('the retired /1 change message is not a message any more', () => {
    expect(parseV2({ protocol: PROTOCOL_V2, type: 'change', values: {}, valid: true }).ok).toBe(false);
  });
});

describe('direction and origin of the frame (what the child accepts on the port)', () => {
  const byName = (name: string) => cases.find((c) => c.name === name)!.input;

  it('accepts init, options.result, lookup.result and collect from the parent', () => {
    for (const name of ['init', 'options-result', 'lookup-result', 'collect']) expect(parseParentMessage(byName(name)).ok, name).toBe(true);
  });

  it('a child-direction message on the port is dropped: `collected` for any req, and every other child type', () => {
    for (const name of ['collected', 'state', 'initialized', 'resize', 'options-request', 'lookup-request', 'error-fatal']) {
      expect(parseParentMessage(byName(name)), name).toEqual({ ok: false, reason: 'direction' });
    }
  });

  it('hello and port are window messages, never port messages', () => {
    expect(parseParentMessage(byName('hello'))).toEqual({ ok: false, reason: 'direction' });
    expect(parseParentMessage(byName('port'))).toEqual({ ok: false, reason: 'direction' });
  });

  it('another protocol version and non-fp-bridge data are named, not parsed', () => {
    expect(parseV2({ protocol: 'fp-bridge/1', type: 'ready', id: 'x', payload: {} })).toEqual({ ok: false, reason: 'protocol', detail: 'fp-bridge/1' });
    expect(parseV2({ hello: 'world' })).toEqual({ ok: false, reason: 'foreign' });
    expect(parseV2('fp-bridge/2')).toEqual({ ok: false, reason: 'foreign' });
    expect(parseV2(null)).toEqual({ ok: false, reason: 'foreign' });
    expect(parseV2([])).toEqual({ ok: false, reason: 'foreign' });
  });

  it('the type guards match the contract lists', () => {
    for (const t of BRIDGE_V2_PARENT_TYPES) expect(isParentType(t)).toBe(true);
    for (const t of BRIDGE_V2_CHILD_TYPES) expect(isChildType(t)).toBe(true);
    expect(isParentType('collected')).toBe(false);
    expect(isChildType('collect')).toBe(false);
  });
});

describe('stampChild: nothing invalid ever leaves the page', () => {
  it('stamps the protocol and returns the checked message', () => {
    const body: ChildBody = { type: 'resize', height: 120 };
    expect(stampChild(body)).toEqual({ protocol: 'fp-bridge/2', type: 'resize', height: 120 });
  });
  it('throws on a message the schema refuses (an unknown key, a bad id)', () => {
    expect(() => stampChild({ type: 'resize', height: 1, token: 'x' } as never)).toThrow(/refusing to send/);
    expect(() => stampChild({ type: 'state', dialogId: 'dlg-1', valid: true, dirty: false, touched: ['not-an-id'] } as never)).toThrow(/refusing to send/);
  });
  it('refuses a parent-direction message', () => {
    expect(() => stampChild({ type: 'collect', dialogId: 'dlg-1', req: 'r4nd0m-req-0000000001' } as never)).toThrow(/refusing to send/);
  });
});

describe('prefillHash', () => {
  /* Pinned vector: classic\'s bridgeProtocolV2.test.ts asserts the same value for the same input. */
  const VALUES = { 'C2000000-0000-4000-8000-000000000101': 'Acme', 'c2000000-0000-4000-8000-000000000102': null, 'c2000000-0000-4000-8000-000000000103': 'Goods' };
  const MASKED = ['c2000000-0000-4000-8000-000000000102'];
  const GOLDEN = prefillHash(VALUES, MASKED);

  it('is 16 hex characters, the shape the contract allows', () => {
    expect(GOLDEN).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is stable: the golden vector of the two repos', () => {
    expect(GOLDEN).toBe('1610d51cf42f8b4f');
  });
  it('ignores key order and the case of ids, and sees a changed value or mask', () => {
    expect(prefillHash({ 'c2000000-0000-4000-8000-000000000103': 'Goods', 'c2000000-0000-4000-8000-000000000101': 'Acme', 'C2000000-0000-4000-8000-000000000102': null }, ['C2000000-0000-4000-8000-000000000102'])).toBe(GOLDEN);
    expect(prefillHash({ ...VALUES, 'c2000000-0000-4000-8000-000000000103': 'Services' }, MASKED)).not.toBe(GOLDEN);
    expect(prefillHash(VALUES, [])).not.toBe(GOLDEN);
  });
});
