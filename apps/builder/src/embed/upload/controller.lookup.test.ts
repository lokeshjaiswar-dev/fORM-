import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, initPayload } from '../bridge/fixtures.ts';
import { parseMessage, type InboundMessage, type InitPayload, type OutboundType, type PayloadOf } from '../bridge/protocol.ts';
import { LOOKUP_TIMEOUT_MS, UploadController } from './controller.ts';

/* The child's half of the lookup exchange (T-BR-L3, L4, L5, L6, L8; contract section 5). */

const fx = fixtures.lookup;
const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = (n: number, name: string) => ({ id: A(n), type: 'textinput', value: name, name, label: name });

function lookupInit(): InitPayload {
  const init = initPayload();
  init.masterFields = [fx.pickerElement as never, target(2, 'City'), target(3, 'Phone'), target(4, 'Tax Id')] as never;
  init.doctypeFields = [];
  init.values = {};
  return init;
}

interface Sent { type: OutboundType; id: string; payload: unknown }

function harness(lookupEnabled: boolean | 'absent' = true) {
  const sent: Sent[] = [];
  let n = 0;
  const controller = new UploadController({
    send: (type, payload: PayloadOf<OutboundType>, replyTo) => {
      n += 1;
      const message = { type, id: `c-${n}`, ...(replyTo ? { replyTo } : {}), payload };
      expect(parseMessage({ protocol: 'fp-bridge/1', ...message }).ok).toBe(true);
      sent.push(message);
      return message.id;
    },
    onRender: () => undefined,
    ...(lookupEnabled === 'absent' ? {} : { lookupEnabled }),
  });
  controller.receive({ protocol: 'fp-bridge/1', type: 'init', id: 'p-init-1', payload: lookupInit() });
  const requests = () => sent.filter((m) => m.type === 'lookup.request');
  const answer = (replyTo: string, payload: Partial<PayloadOf<'lookup.result'>> = {}) =>
    controller.receive({
      protocol: 'fp-bridge/1',
      type: 'lookup.result',
      id: `p-${replyTo}`,
      replyTo,
      payload: { lookupId: 'vendor', status: 'ok', rows: fx.exchange[1].payload.rows, truncated: false, ...payload },
    } as InboundMessage);
  return { controller, sent, requests, answer };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('UploadController.lookup', () => {
  it('sends lookup.request for a declared lookup and resolves with the rows of the answer', async () => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0]!.payload).toEqual({ lookupId: 'vendor', search: 'acm' });
    h.answer(h.requests()[0]!.id);
    expect(await rows).toEqual({ rows: [{ label: 'Acme Traders', cells: fx.exchange[1].payload.rows[0]!.cells }], truncated: false });
  });

  it('T-BR-L6: without fp_caps=lookup no request is sent, and the answer is no rows', async () => {
    for (const enabled of [false, 'absent'] as const) {
      const h = harness(enabled);
      await expect(h.controller.lookup('vendor', 'acm')).resolves.toEqual({ rows: [], truncated: false });
      expect(h.requests()).toHaveLength(0);
    }
  });

  it('T-BR-L5: an id the init did not declare sends nothing', async () => {
    const h = harness();
    await expect(h.controller.lookup('other', 'acm')).resolves.toEqual({ rows: [], truncated: false });
    expect(h.requests()).toHaveLength(0);
  });

  it('no request before an init', async () => {
    const sent: unknown[] = [];
    const controller = new UploadController({ send: ((t: string) => (sent.push(t), 'x')) as never, onRender: () => undefined, lookupEnabled: true });
    await expect(controller.lookup('vendor', 'a')).resolves.toEqual({ rows: [], truncated: false });
    expect(sent).toHaveLength(0);
  });

  it('T-BR-L3: an unknown replyTo, or a lookupId other than the one asked, is dropped and the request stays open', async () => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    const id = h.requests()[0]!.id;
    h.answer('c-999');
    h.answer(id, { lookupId: 'other' });
    let settled = false;
    void rows.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.answer(id);
    expect((await rows).rows).toHaveLength(1);
  });

  it('a newer request for the same lookup supersedes the older: the older gets no rows and its late answer is dropped', async () => {
    const h = harness();
    const first = h.controller.lookup('vendor', 'a');
    const second = h.controller.lookup('vendor', 'ac');
    expect(h.requests()).toHaveLength(2);
    await expect(first).resolves.toEqual({ rows: [], truncated: false });
    h.answer(h.requests()[0]!.id); // late answer to the first: ignored
    h.answer(h.requests()[1]!.id);
    expect((await second).rows[0]!.label).toBe('Acme Traders');
  });

  it('a result applies once: a second answer to the same id is dropped', async () => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    const id = h.requests()[0]!.id;
    h.answer(id);
    await rows;
    expect(() => h.answer(id, { rows: [{ label: 'Other', cells: {} }] })).not.toThrow();
  });

  it('T-BR-L8 (child side): cells for ids the lookup does not declare are ignored, and an empty label drops the row', async () => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    h.answer(h.requests()[0]!.id, {
      rows: [
        { label: 'Acme', cells: { [B(1)]: 'Acme', [B(2)]: 'Pune', [B(5)]: 'do not share', [A(1)]: 'sneaky', 'b2000000-0000-4000-8000-0000000000ff': 'x' } },
        { label: '  ', cells: { [B(1)]: 'blank' } },
      ],
    });
    expect(await rows).toEqual({ rows: [{ label: 'Acme', cells: { [B(1)]: 'Acme', [B(2)]: 'Pune' } }], truncated: false });
  });

  it.each(['unknown_lookup', 'forbidden', 'unavailable', 'rate_limited'] as const)('status %s gives no rows', async (status) => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    h.answer(h.requests()[0]!.id, { status });
    expect(await rows).toEqual({ rows: [], truncated: false });
  });

  it('no answer in 8 s gives no rows, and a late answer is dropped', async () => {
    const h = harness();
    const rows = h.controller.lookup('vendor', 'acm');
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
    await expect(rows).resolves.toEqual({ rows: [], truncated: false });
    expect(() => h.answer(h.requests()[0]!.id)).not.toThrow();
  });

  it('a new init and a dispose end open lookups with no rows', async () => {
    const h = harness();
    const first = h.controller.lookup('vendor', 'a');
    h.controller.receive({ protocol: 'fp-bridge/1', type: 'init', id: 'p-init-2', payload: lookupInit() });
    await expect(first).resolves.toEqual({ rows: [], truncated: false });
    const second = h.controller.lookup('vendor', 'a');
    h.controller.dispose();
    await expect(second).resolves.toEqual({ rows: [], truncated: false });
  });

  it('the search text is cut to 100 characters and no token or other field rides in the message', () => {
    const h = harness();
    void h.controller.lookup('vendor', 'x'.repeat(300));
    expect(h.requests()[0]!.payload).toEqual({ lookupId: 'vendor', search: 'x'.repeat(100) });
  });
});
