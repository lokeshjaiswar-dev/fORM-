import { describe, expect, it } from 'vitest';
import { fixtures } from './fixtures.ts';
import { INBOUND_TYPES, OUTBOUND_TYPES, parseMessage, type BridgeMessage } from './protocol.ts';

/* The zod mirror of contract/fp-bridge-v1.schema.json against the contract fixtures. */

const accepted = (label: string, message: unknown) => {
  const result = parseMessage(message);
  expect(result.ok, `${label}: ${result.ok ? '' : `${result.reason} ${result.detail ?? ''}`}`).toBe(true);
};

describe('parseMessage on the contract fixtures', () => {
  it('accepts every message of the handshake and the options exchange', () => {
    fixtures.handshake.forEach((m, i) => accepted(`handshake[${i}]`, m));
    fixtures.optionsExchange.forEach((m, i) => accepted(`optionsExchange[${i}]`, m));
  });

  it('accepts every validate, change, validated and initialized the fixtures expect', () => {
    for (const c of fixtures.cases) {
      accepted(`${c.name} validate`, c.validate);
      accepted(`${c.name} validated`, c.expectedValidated);
      if (c.expectedChange) accepted(`${c.name} change`, c.expectedChange);
    }
    accepted('unsupported init', fixtures.unsupported.init);
    accepted('unsupported initialized', fixtures.unsupported.expectedInitialized);
  });

  it.each(fixtures.mustBeRejected.map((r) => [r.why, r.message] as const))('rejects: %s', (_why, message) => {
    expect(parseMessage(message).ok).toBe(false);
  });

  it('tells a foreign protocol version from a malformed message and from noise', () => {
    expect(parseMessage(fixtures.mustBeRejected[0]!.message)).toMatchObject({ ok: false, reason: 'protocol' });
    expect(parseMessage(fixtures.mustBeRejected[1]!.message)).toMatchObject({ ok: false, reason: 'invalid', type: 'init' });
    for (const noise of [null, 'x', 7, [], {}, { type: 'init' }, { protocol: 'webpack' }]) expect(parseMessage(noise)).toMatchObject({ ok: false, reason: 'foreign' });
  });

  it('closes every payload: a credential next to the fields is refused, in each message type', () => {
    for (const m of [...fixtures.handshake, ...fixtures.optionsExchange, fixtures.cases[0]!.validate, fixtures.cases[0]!.expectedValidated] as BridgeMessage[]) {
      const smuggled = { ...m, payload: { ...m.payload, token: 'Bearer abc' } };
      expect(parseMessage(smuggled).ok, m.type).toBe(false);
      expect(parseMessage({ ...m, extra: 1 }).ok, `${m.type} envelope`).toBe(false);
    }
  });

  it('requires replyTo on initialized, options.result and validated', () => {
    for (const m of [fixtures.handshake[2], fixtures.optionsExchange[1], fixtures.cases[0]!.expectedValidated] as BridgeMessage[]) {
      const { replyTo: _dropped, ...rest } = m;
      expect(parseMessage(rest).ok, m.type).toBe(false);
    }
  });

  it('keeps unknown element keys from DMS and refuses a bad field id, an unknown error code and an oversized option list', () => {
    const init = structuredClone(fixtures.handshake[1]) as Extract<BridgeMessage, { type: 'init' }>;
    (init.payload.doctypeFields[0] as Record<string, unknown>).future_key = { a: 1 };
    accepted('open element', init);
    const bad = structuredClone(init);
    bad.payload.doctypeFields[0]!.id = 'not-a-uuid';
    expect(parseMessage(bad).ok).toBe(false);
    expect(parseMessage({ protocol: 'fp-bridge/1', type: 'error', id: 'e1', payload: { code: 'boom', fatal: true } }).ok).toBe(false);
    const result = structuredClone(fixtures.optionsExchange[1]) as Extract<BridgeMessage, { type: 'options.result' }>;
    result.payload.options = Array.from({ length: 501 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    expect(parseMessage(result).ok).toBe(false);
  });
});

describe('fp-bridge/1 lookup messages (additive)', () => {
  it('accepts the fixture exchange and rejects every mustBeRejected case', () => {
    fixtures.lookup.exchange.forEach((m, i) => accepted(`lookup.exchange[${i}]`, m));
    for (const r of fixtures.lookup.mustBeRejected) expect(parseMessage(r.message).ok, r.why).toBe(false);
  });

  it('keeps fp_lookup on a master element (the element schema is open) and closes the lookup payloads', () => {
    const init = structuredClone(fixtures.handshake[1]) as Extract<BridgeMessage, { type: 'init' }>;
    init.payload.masterFields = [fixtures.lookup.pickerElement as never];
    const parsed = parseMessage(init);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.message as typeof init).payload.masterFields[0]).toHaveProperty('fp_lookup');
    for (const m of fixtures.lookup.exchange) expect(parseMessage({ ...m, payload: { ...m.payload, token: 'Bearer abc' } }).ok, m.type).toBe(false);
  });

  it('routes lookup.request out of the child and lookup.result into it, and leaves ready and init unchanged', () => {
    expect(OUTBOUND_TYPES).toContain('lookup.request');
    expect(INBOUND_TYPES).toContain('lookup.result');
    expect(INBOUND_TYPES).not.toContain('lookup.request');
    expect(OUTBOUND_TYPES).not.toContain('lookup.result');
    // an old parent still validates the child's ready: no new capability value
    expect(parseMessage({ protocol: 'fp-bridge/1', type: 'ready', id: 'r', payload: { version: '1', capabilities: ['lookup'] } }).ok).toBe(false);
    expect(fixtures.lookup.childUrlCaps).toBe('lookup');
  });
});
