import { describe, expect, it, vi } from 'vitest';
import raw from '@/embed/contract/__fixtures__/fp-bridge-v2.fixtures.json' with { type: 'json' };
import { ChildPort } from './childPort.ts';
import type { ParentMessage } from './protocolV2.ts';

/* T-59 (SEC-DESIGN 10.3): the child hands nothing to a window that is not its parent, from an unlisted origin, a second time, or when the allowlist is empty. */

const caseInput = (name: string) => structuredClone((raw as unknown as { cases: Array<{ name: string; input: unknown }> }).cases.find((c) => c.name === name)!.input);
const PORT_MSG = caseInput('port');
const INIT_MSG = caseInput('init');
const COLLECT_MSG = caseInput('collect');
const DMS = 'https://dms.example';

/** A window with the two methods the child uses, and a way to deliver an event. */
function fakeWindow() {
  let handler: ((e: MessageEvent) => void) | null = null;
  return {
    addEventListener: vi.fn((_type: string, h: (e: MessageEvent) => void) => void (handler = h)),
    removeEventListener: vi.fn((_type: string, h: (e: MessageEvent) => void) => void (handler === h && (handler = null))),
    get listening() {
      return handler !== null;
    },
    deliver(event: Partial<MessageEvent>) {
      handler?.(event as MessageEvent);
    },
  };
}

function fakePort() {
  const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn(), start: vi.fn(), close: vi.fn() };
  return Object.assign(port, { receive: (data: unknown) => port.onmessage?.({ data } as MessageEvent) });
}

function setup(allowedParents: readonly string[] = [DMS]) {
  const self = fakeWindow();
  const parent = { postMessage: vi.fn() };
  const other = { postMessage: vi.fn() };
  const onPort = vi.fn();
  const onMessage = vi.fn<(m: ParentMessage) => void>();
  const onDropped = vi.fn();
  const link = new ChildPort({ self: self as never, parent, allowedParents, onPort, onMessage, onDropped });
  const handover = (over: Partial<MessageEvent> = {}, port = fakePort()) => {
    self.deliver({ source: parent as never, origin: DMS, data: PORT_MSG, ports: [port as never], ...over });
    return port;
  };
  return { self, parent, other, onPort, onMessage, onDropped, link, handover };
}

describe('hello', () => {
  it('says an empty hello to window.parent with target "*" (an opaque child cannot know the parent origin) and listens', () => {
    const t = setup();
    expect(t.link.start()).toBe(true);
    expect(t.parent.postMessage).toHaveBeenCalledTimes(1);
    expect(t.parent.postMessage).toHaveBeenCalledWith({ protocol: 'fp-bridge/2', type: 'hello' }, '*');
    expect(t.self.listening).toBe(true);
  });

  it('with an EMPTY allowlist nothing is sent and nothing is listened to: deny, not "own origin"', () => {
    const t = setup([]);
    expect(t.link.start()).toBe(false);
    expect(t.parent.postMessage).not.toHaveBeenCalled();
    expect(t.self.addEventListener).not.toHaveBeenCalled();
    expect(t.onDropped).toHaveBeenCalledWith(expect.stringContaining('VITE_FP_EMBED_PARENTS'));
    t.handover();
    expect(t.onPort).not.toHaveBeenCalled();
    expect(t.link.connected).toBe(false);
  });

  it('start is idempotent: one hello', () => {
    const t = setup();
    t.link.start();
    t.link.start();
    expect(t.parent.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('the port handover (T-59)', () => {
  it('takes the port from window.parent at an allowlisted origin, with one port, and reports the dialog', () => {
    const t = setup();
    t.link.start();
    const port = t.handover();
    expect(t.onPort).toHaveBeenCalledWith('dlg-1');
    expect(t.link.connected).toBe(true);
    expect(t.link.dialogId).toBe('dlg-1');
    expect(port.start).toHaveBeenCalled();
    expect(t.self.listening).toBe(false); // from now on only the port
  });

  it('ignores a port message from another window (a sibling frame, an opener)', () => {
    const t = setup();
    t.link.start();
    const port = t.handover({ source: t.other as never });
    t.handover({ source: null });
    expect(t.onPort).not.toHaveBeenCalled();
    expect(port.start).not.toHaveBeenCalled();
    expect(t.link.connected).toBe(false);
  });

  it('ignores a port message from an origin that is not on the allowlist, and from "null"', () => {
    const t = setup([DMS, 'https://classic.example']);
    t.link.start();
    for (const origin of ['https://evil.example', 'null', 'http://dms.example', 'https://dms.example.evil.example', '']) t.handover({ origin });
    expect(t.onPort).not.toHaveBeenCalled();
    t.handover({ origin: 'https://classic.example' });
    expect(t.onPort).toHaveBeenCalledTimes(1);
  });

  it('takes exactly one: a second port message is ignored, and its port is never started', () => {
    const t = setup();
    t.link.start();
    const first = t.handover();
    const second = t.handover();
    expect(t.onPort).toHaveBeenCalledTimes(1);
    expect(second.start).not.toHaveBeenCalled();
    first.receive(COLLECT_MSG);
    expect(t.onMessage).toHaveBeenCalledTimes(1);
  });

  it('does not take a port handover without exactly one port, and the next good one still works', () => {
    const t = setup();
    t.link.start();
    t.handover({ ports: [] as never });
    t.handover({ ports: undefined as never });
    expect(t.onPort).not.toHaveBeenCalled();
    t.handover({ ports: [fakePort(), fakePort()] as never });
    expect(t.onPort).not.toHaveBeenCalled();
    expect(t.onDropped).toHaveBeenCalledWith(expect.stringContaining('exactly one port'));
    t.handover();
    expect(t.onPort).toHaveBeenCalledTimes(1);
  });

  it('does not take anything that is not a port message: an init on the window, a /1 message, junk', () => {
    const t = setup();
    t.link.start();
    t.handover({ data: INIT_MSG });
    t.handover({ data: { protocol: 'fp-bridge/1', type: 'init', id: 'x', payload: {} } });
    t.handover({ data: 'hello' });
    t.handover({ data: { protocol: 'fp-bridge/2', type: 'port' } }); // no dialogId
    t.handover({ data: { ...(PORT_MSG as object), origin: DMS } }); // an extra key
    expect(t.onPort).not.toHaveBeenCalled();
    expect(t.link.connected).toBe(false);
  });
});

describe('on the port', () => {
  function connected() {
    const t = setup();
    t.link.start();
    const port = t.handover();
    return { ...t, port };
  }

  it('delivers schema-valid parent messages and drops everything else without an answer', () => {
    const t = connected();
    t.port.receive(INIT_MSG);
    t.port.receive(COLLECT_MSG);
    expect(t.onMessage).toHaveBeenCalledTimes(2);
    t.port.receive({ protocol: 'fp-bridge/2', type: 'collected', dialogId: 'dlg-1', req: 'r4nd0m-req-0000000001', valid: true, errors: [], values: {}, prefillHash: 'a1b2c3d4e5f60718' }); // wrong direction
    t.port.receive({ protocol: 'fp-bridge/2', type: 'collect', dialogId: 'dlg-1' }); // invalid
    t.port.receive('junk');
    expect(t.onMessage).toHaveBeenCalledTimes(2);
    expect(t.port.postMessage).not.toHaveBeenCalled();
  });

  it('sends child messages on the port, stamped and schema-checked; send before the port is false', () => {
    const t = setup();
    expect(t.link.send({ type: 'resize', height: 10 })).toBe(false);
    t.link.start();
    const port = t.handover();
    expect(t.link.send({ type: 'resize', height: 10 })).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith({ protocol: 'fp-bridge/2', type: 'resize', height: 10 });
    expect(() => t.link.send({ type: 'resize', height: 10, token: 'x' } as never)).toThrow();
    // Never on the window: the only window message the child ever sends is hello.
    expect(t.parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it('stop closes the port and forgets the dialog; the window listener is gone', () => {
    const t = connected();
    t.link.stop();
    expect(t.port.close).toHaveBeenCalled();
    expect(t.link.connected).toBe(false);
    expect(t.link.dialogId).toBeNull();
    expect(t.self.listening).toBe(false);
  });

  it('stop before the handover removes the window listener', () => {
    const t = setup();
    t.link.start();
    t.link.stop();
    expect(t.self.listening).toBe(false);
    t.handover();
    expect(t.onPort).not.toHaveBeenCalled();
  });
});
