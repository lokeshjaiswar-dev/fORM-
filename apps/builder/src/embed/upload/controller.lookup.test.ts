import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures } from '../bridge/fixtures.ts';
import type { InitMessage } from '../bridge/protocolV2.ts';
import { LOOKUP_TIMEOUT_MS } from './controller.ts';
import { harness, type ChildOf, v2Init } from './v2Harness.ts';

/* The child's half of the lookup exchange over fp-bridge/2 (T-BR-L3, L4, L5, L8; contract section 5): declared lookup ids only, the parent answers on the port. */

const fx = fixtures.lookup;
const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = (n: number) => `b2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = (n: number, name: string) => ({ id: A(n), type: 'textinput', value: name, name, label: name });

function lookupInit(lookups: string[] = ['vendor']): InitMessage {
  return { ...v2Init(), doctypeFields: [], masterFields: [fx.pickerElement as never, target(2, 'City'), target(3, 'Phone'), target(4, 'Tax Id')] as never, values: {}, masked: [], lookups };
}

function setup(lookups?: string[]) {
  const h = harness();
  h.init(lookupInit(lookups));
  const requests = () => h.ofType('lookup.request') as Array<ChildOf<'lookup.request'>>;
  const answer = (replyTo: string, over: Partial<{ lookupId: string; status: string; rows: unknown; truncated: boolean }> = {}) =>
    h.send({ protocol: 'fp-bridge/2', type: 'lookup.result', replyTo, lookupId: 'vendor', status: 'ok', rows: fx.exchange[1].payload.rows, truncated: false, ...over } as never);
  return { ...h, requests, answer };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('UploadController.lookup', () => {
  it('sends lookup.request for a declared lookup and resolves with the rows of the answer', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    expect(h.requests()).toHaveLength(1);
    expect(h.requests()[0]).toMatchObject({ lookupId: 'vendor', search: 'acm' });
    h.answer(h.requests()[0]!.id);
    expect(await rows).toEqual({ rows: [{ label: 'Acme Traders', cells: fx.exchange[1].payload.rows[0]!.cells }], truncated: false });
  });

  it('an id the init did not declare in init.lookups sends nothing (the parent budget and the declared list are the only way in)', async () => {
    const h = setup([]); // the picker is declared by its element, but the parent did not list it
    await expect(h.controller.lookup('vendor', 'acm')).resolves.toEqual({ rows: [], truncated: false });
    expect(h.requests()).toHaveLength(0);
  });

  it('T-BR-L5: an id no element declares sends nothing', async () => {
    const h = setup(['vendor', 'other']);
    await expect(h.controller.lookup('other', 'acm')).resolves.toEqual({ rows: [], truncated: false });
    expect(h.requests()).toHaveLength(0);
  });

  it('no request before an init', async () => {
    const h = harness();
    await expect(h.controller.lookup('vendor', 'a')).resolves.toEqual({ rows: [], truncated: false });
    expect(h.sent).toHaveLength(0);
  });

  it('T-BR-L3: an unknown replyTo, or a lookupId other than the one asked, is dropped and the request stays open', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    const id = h.requests()[0]!.id;
    h.answer('c-l-999');
    h.answer(id, { lookupId: 'other' });
    let settled = false;
    void rows.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.answer(id);
    expect((await rows).rows).toHaveLength(1);
  });

  it('a newer request for the same lookup supersedes the older: the older gets no rows and its late answer is dropped', async () => {
    const h = setup();
    const first = h.controller.lookup('vendor', 'a');
    const second = h.controller.lookup('vendor', 'ac');
    expect(h.requests()).toHaveLength(2);
    await expect(first).resolves.toEqual({ rows: [], truncated: false });
    h.answer(h.requests()[0]!.id);
    h.answer(h.requests()[1]!.id);
    expect((await second).rows[0]!.label).toBe('Acme Traders');
  });

  it('a result applies once: a second answer to the same id is dropped', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    const id = h.requests()[0]!.id;
    h.answer(id);
    await rows;
    expect(() => h.answer(id, { rows: [{ label: 'Other', cells: {} }] })).not.toThrow();
  });

  it('T-BR-L8 (child side): cells for ids the lookup does not declare are ignored, and an empty label drops the row', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    h.answer(h.requests()[0]!.id, {
      rows: [
        { label: 'Acme', cells: { [B(1)]: 'Acme', [B(2)]: 'Pune', [B(5)]: 'do not share', [A(1)]: 'sneaky', 'b2000000-0000-4000-8000-0000000000ff': 'x' } },
        { label: '  ', cells: { [B(1)]: 'blank' } },
      ],
    });
    expect(await rows).toEqual({ rows: [{ label: 'Acme', cells: { [B(1)]: 'Acme', [B(2)]: 'Pune' } }], truncated: false });
  });

  it('T-BR-L8 (child side): a cell or a label that is the DMS secret mask is dropped again (defence in depth)', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    const MASK = '•'.repeat(6);
    h.answer(h.requests()[0]!.id, {
      rows: [
        { label: 'Acme', cells: { [B(1)]: 'Acme', [B(2)]: MASK, [B(3)]: '98' } },
        { label: MASK, cells: { [B(1)]: MASK } },
      ],
    });
    expect(await rows).toEqual({ rows: [{ label: 'Acme', cells: { [B(1)]: 'Acme', [B(3)]: '98' } }], truncated: false });
  });

  it.each(['unknown_lookup', 'forbidden', 'unavailable', 'rate_limited'] as const)('status %s gives no rows', async (status) => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    h.answer(h.requests()[0]!.id, { status });
    expect(await rows).toEqual({ rows: [], truncated: false });
  });

  it('no answer in 8 s gives no rows, and a late answer is dropped', async () => {
    const h = setup();
    const rows = h.controller.lookup('vendor', 'acm');
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
    await expect(rows).resolves.toEqual({ rows: [], truncated: false });
    expect(() => h.answer(h.requests()[0]!.id)).not.toThrow();
  });

  it('a new init and a dispose end open lookups with no rows', async () => {
    const h = setup();
    const first = h.controller.lookup('vendor', 'a');
    h.init(lookupInit());
    await expect(first).resolves.toEqual({ rows: [], truncated: false });
    const second = h.controller.lookup('vendor', 'a');
    h.controller.dispose();
    await expect(second).resolves.toEqual({ rows: [], truncated: false });
  });

  it('the search text is cut to 100 characters and nothing else rides in the message', () => {
    const h = setup();
    void h.controller.lookup('vendor', 'x'.repeat(300));
    expect(h.requests()[0]).toEqual({ protocol: 'fp-bridge/2', type: 'lookup.request', id: expect.stringMatching(/^c-l-/), lookupId: 'vendor', search: 'x'.repeat(100) });
  });
});
