import { describe, expect, it, vi } from 'vitest';
import { ChildTransport } from './childTransport.ts';
import { fixtures } from './fixtures.ts';
import { parseMessage, type InboundMessage } from './protocol.ts';

const PARENT = 'https://dms.example';

/** A parent window and a self window as plain objects: `message` events are dispatched by hand. */
function harness() {
  const parent = { postMessage: vi.fn() };
  const listeners = new Set<(e: MessageEvent) => void>();
  const self = {
    addEventListener: (_t: string, l: unknown) => void listeners.add(l as (e: MessageEvent) => void),
    removeEventListener: (_t: string, l: unknown) => void listeners.delete(l as (e: MessageEvent) => void),
  } as unknown as Window;
  const received: InboundMessage[] = [];
  const dropped: string[] = [];
  const transport = new ChildTransport({ self, parent, parentOrigin: PARENT, onMessage: (m) => void received.push(m), onDropped: (w) => void dropped.push(w) });
  const deliver = (data: unknown, over: { source?: unknown; origin?: string } = {}) => {
    const event = { data, source: 'source' in over ? over.source : parent, origin: over.origin ?? PARENT } as unknown as MessageEvent;
    for (const l of [...listeners]) l(event);
  };
  return { parent, listeners, transport, received, dropped, deliver };
}

const init = fixtures.handshake[1]!;

describe('ChildTransport', () => {
  it('delivers a schema-valid message from the parent window and origin', () => {
    const h = harness();
    h.transport.start();
    h.deliver(init);
    h.deliver(fixtures.cases[0]!.validate);
    expect(h.received.map((m) => m.type)).toEqual(['init', 'validate']);
  });

  it('ignores, without answering, a message from another window or another origin', () => {
    const h = harness();
    h.transport.start();
    h.deliver(init, { source: { postMessage: vi.fn() } });
    h.deliver(init, { source: null });
    h.deliver(init, { origin: 'https://evil.example' });
    h.deliver(init, { origin: 'null' });
    h.deliver(init, { origin: 'https://dms.example.evil.example' });
    expect(h.received).toEqual([]);
    expect(h.parent.postMessage).not.toHaveBeenCalled();
    expect(h.dropped).toEqual([]);
  });

  it('ignores types the parent may not send (ready, validated...) and noise', () => {
    const h = harness();
    h.transport.start();
    h.deliver(fixtures.handshake[0]);
    h.deliver(fixtures.cases[0]!.expectedValidated);
    h.deliver('hello');
    h.deliver({ protocol: 'other', type: 'init' });
    expect(h.received).toEqual([]);
    expect(h.parent.postMessage).not.toHaveBeenCalled();
  });

  it('answers a foreign protocol version with a fatal unsupported_version, and a bad init with invalid_init, at most three times', () => {
    const h = harness();
    h.transport.start();
    h.deliver(fixtures.mustBeRejected[0]!.message);
    h.deliver(fixtures.mustBeRejected[1]!.message);
    h.deliver(fixtures.mustBeRejected[0]!.message);
    h.deliver(fixtures.mustBeRejected[0]!.message);
    const sent = h.parent.postMessage.mock.calls.map(([m]) => m as { type: string; payload: { code: string; fatal: boolean } });
    expect(sent.map((m) => [m.type, m.payload.code, m.payload.fatal])).toEqual([
      ['error', 'unsupported_version', true],
      ['error', 'invalid_init', true],
      ['error', 'unsupported_version', true],
    ]);
    expect(h.received).toEqual([]);
  });

  it('a malformed validate (right protocol) is dropped quietly', () => {
    const h = harness();
    h.transport.start();
    h.deliver({ protocol: 'fp-bridge/1', type: 'validate', id: 'v', payload: { x: 1 } });
    expect(h.parent.postMessage).not.toHaveBeenCalled();
    expect(h.dropped).toHaveLength(1);
  });

  it('posts to the parent origin only, with a schema-valid envelope and unique ids', () => {
    const h = harness();
    const a = h.transport.send('ready', { version: '1', capabilities: ['options', 'readOnly'] });
    const b = h.transport.send('initialized', { fieldCount: 1, unsupported: [] }, 'p-init-1');
    expect(a).not.toBe(b);
    for (const [message, target] of h.parent.postMessage.mock.calls) {
      expect(target).toBe(PARENT);
      expect(parseMessage(message).ok).toBe(true);
    }
    expect(h.parent.postMessage.mock.calls[1]![0]).toMatchObject({ replyTo: 'p-init-1' });
  });

  it('start is idempotent (one listener) and stop removes it', () => {
    const h = harness();
    h.transport.start();
    h.transport.start();
    expect(h.listeners.size).toBe(1);
    h.deliver(init);
    expect(h.received).toHaveLength(1);
    h.transport.stop();
    expect(h.listeners.size).toBe(0);
    h.deliver(init);
    expect(h.received).toHaveLength(1);
  });
});
