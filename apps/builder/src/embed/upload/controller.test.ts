import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitMessage } from '../bridge/protocolV2.ts';
import { prefillHash } from '../bridge/protocolV2.ts';
import { DIALOG, F, REQ, harness, v2Init } from './v2Harness.ts';
import { STATE_DEBOUNCE_MS } from './controller.ts';

/* The child's behaviour behind fp-bridge/2, driven message by message against the contract's `init` fixture. */

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const U = (n: number) => `c3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const dropdown = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ id: U(n), type: 'dropdown', value: name, name, label: name, required: false, placeholder: '', field_source: 'master', is_secret: false, ...extra });
/** An init whose dropdowns have no options of their own, so the child asks the parent for them. */
function remoteInit(masterFields: unknown[]): InitMessage {
  return { ...v2Init(), doctypeFields: [], masterFields: masterFields as never, values: {}, masked: [], lookups: [] };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('init', () => {
  it('shows the form in two titled sections and answers initialized with the dialog id, the field count and no unsupported ids', () => {
    const h = harness();
    h.init();
    expect(h.ofType('initialized')).toEqual([{ protocol: 'fp-bridge/2', type: 'initialized', dialogId: DIALOG, fieldCount: 9, unsupported: [] }]);
    const def = h.view().plan.version.definition;
    const titles = def.pages[0]!.children.map((id) => JSON.stringify(def.blocks[id]));
    expect(titles[0]).toContain('Document details');
    expect(titles[1]).toContain('Master details');
    expect(h.ofType('options.request')).toHaveLength(0); // every dropdown of the fixture carries its own options
  });

  it('an init for another dialog is dropped: no form, no answer', () => {
    const h = harness();
    h.init({ ...v2Init(), dialogId: 'dlg-other' });
    expect(h.sent).toHaveLength(0);
    expect(h.renders).toHaveLength(0);
    expect(h.problems[0]).toMatch(/^dialog:/);
  });

  it('a type outside the seven: initialized names the ids and no form is shown (the parent shows its own, empty)', () => {
    const h = harness();
    const init = v2Init();
    init.doctypeFields = [{ id: 'd2000000-0000-4000-8000-000000000001', type: 'checkboxes', label: '', value: 'Flags', required: false } as never];
    init.masterFields = [];
    init.values = {};
    init.masked = [];
    init.lookups = [];
    h.init(init);
    expect(h.ofType('initialized')[0]).toMatchObject({ fieldCount: 1, unsupported: ['d2000000-0000-4000-8000-000000000001'] });
    expect(h.view()).toBeNull();
  });

  it('a form the plan cannot build is a fatal invalid_init error that carries only the code', () => {
    const h = harness();
    const init = v2Init();
    init.masterFields = [...init.masterFields, init.masterFields[0]!]; // the same field id twice
    h.init(init);
    expect(h.ofType('error')).toEqual([{ protocol: 'fp-bridge/2', type: 'error', code: 'invalid_init', fatal: true }]);
    expect(h.problems[0]).toMatch(/appears twice/);
    expect(h.view()).toBeNull();
  });

  it('a re-sent init replaces the form and answers again (idempotent)', () => {
    const h = harness();
    h.init();
    h.init();
    expect(h.ofType('initialized')).toHaveLength(2);
    expect(h.renders).toHaveLength(2);
    expect(h.view().revision).toBe(2);
  });

  it('the increment field is read-only with its stored number; the legacy field is read-only; neither is ever collected', async () => {
    const h = harness();
    h.init();
    const def = h.view().plan.version.definition;
    expect((def.blocks[F.invoiceNo as never] as { readOnly?: boolean }).readOnly).toBe(true);
    expect((def.blocks[F.docs as never] as { readOnly?: boolean }).readOnly).toBe(true);
    expect(h.view().plan.initialAnswers[F.invoiceNo as never]).toEqual({ type: 'short_text', value: 'INV-0007' });
    h.collect();
    await flush();
    const values = h.ofType('collected')[0]!.values;
    expect(values).not.toHaveProperty(F.invoiceNo);
    expect(values).not.toHaveProperty(F.docs);
  });
});

describe('state: valid, dirty and which fields were touched, never a value', () => {
  it('nothing is sent until the person edits; then one debounced state after the last edit', () => {
    const h = harness();
    h.init();
    vi.advanceTimersByTime(1000);
    expect(h.ofType('state')).toHaveLength(0);
    h.edit({ [F.vendorName]: 'Acme Ltd' });
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS - 1);
    expect(h.ofType('state')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.ofType('state')).toEqual([{ protocol: 'fp-bridge/2', type: 'state', dialogId: DIALOG, valid: true, dirty: true, touched: [F.vendorName] }]);
  });

  it('state carries no value: what was typed appears in no message but collected', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Zebra Traders' });
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(JSON.stringify(h.sent)).not.toContain('Zebra');
    h.collect();
    await flush();
    expect(JSON.stringify(h.ofType('collected'))).toContain('Zebra Traders');
    expect(JSON.stringify(h.sent.filter((m) => m.type !== 'collected'))).not.toContain('Zebra');
  });

  it('valid turns false for a value DMS would refuse', () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme 2' }); // alphabets only
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    expect(h.ofType('state').at(-1)).toMatchObject({ valid: false, dirty: true });
  });

  it('an edit that changes nothing sends nothing', () => {
    const h = harness();
    h.init();
    h.edit({});
    vi.advanceTimersByTime(1000);
    expect(h.ofType('state')).toHaveLength(0);
  });
});

describe('collect -> collected, once per req', () => {
  it('answers with the verdict, the values by field id and the prefill hash of the init it was made from', async () => {
    const h = harness();
    const init = v2Init();
    h.init(init);
    h.collect();
    await flush();
    const [collected] = h.ofType('collected');
    expect(collected).toMatchObject({ dialogId: DIALOG, req: REQ, valid: true, errors: [], prefillHash: prefillHash(init.values, init.masked) });
    expect(collected!.values).toEqual({
      [F.invoiceDate]: '26-11-2026', // default to today, from the parent's clock
      [F.vendorName]: 'Acme',
      [F.category]: 'Goods',
      [F.subCategory]: '',
      [F.preferred]: '',
      [F.vendorCode]: '',
    });
    expect(Object.keys(collected!.values)).not.toContain(F.taxId); // masked and untouched
  });

  it('the same req twice gives one collected; another req gives another', async () => {
    const h = harness();
    h.init();
    h.collect();
    h.collect();
    await flush();
    expect(h.ofType('collected')).toHaveLength(1);
    h.collect('r4nd0m-req-0000000002');
    await flush();
    expect(h.ofType('collected').map((m) => m.req)).toEqual([REQ, 'r4nd0m-req-0000000002']);
  });

  it('a collect for another dialog is dropped', async () => {
    const h = harness();
    h.init();
    h.collect(REQ, 'dlg-other');
    await flush();
    expect(h.ofType('collected')).toHaveLength(0);
    expect(h.problems.at(-1)).toMatch(/^dialog:/);
  });

  it('a collect before any usable init is a non-fatal internal error, and the req is not spent on it', async () => {
    const h = harness();
    h.collect();
    await flush();
    expect(h.ofType('error')).toEqual([{ protocol: 'fp-bridge/2', type: 'error', code: 'internal', fatal: false }]);
    expect(h.ofType('collected')).toHaveLength(0);
  });

  it('reports the errors by field id and code, with the values as typed', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme 2', [F.vendorCode]: 'x' }, { [F.vendorCode]: { type: 'number', value: '12.5' } as never });
    h.collect();
    await flush();
    const collected = h.ofType('collected')[0]!;
    expect(collected.valid).toBe(false);
    expect(collected.errors.map((e) => `${e.fieldId}:${e.code}`).sort()).toEqual([`${F.vendorCode}:not_integer`, `${F.vendorName}:pattern`].sort());
    expect(collected.values[F.vendorName]).toBe('Acme 2');
    expect(collected.values[F.vendorCode]).toBe('12.5');
  });

  it('a missing required field is reported as required', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: '' });
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.errors).toEqual([{ fieldId: F.vendorName, code: 'required', message: expect.stringContaining('Vendor Name') }]);
  });

  it('shows the renderer\'s inline errors first, and a renderer that never answers does not hold the answer back', async () => {
    const shown = vi.fn(() => new Promise<void>(() => undefined));
    const h = harness({ showInlineErrors: shown });
    h.init();
    h.collect();
    await flush();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(h.ofType('collected')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.ofType('collected')).toHaveLength(1);
  });

  it('an init that arrives while the answer is being prepared drops that answer (the parent\'s collect timeout covers it)', async () => {
    const h = harness({ showInlineErrors: () => new Promise((resolve) => setTimeout(resolve, 100)) });
    h.init();
    h.collect();
    h.init();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.ofType('collected')).toHaveLength(0);
  });

  it('a read-only form reports no errors', async () => {
    const h = harness();
    h.init({ ...v2Init(), readOnly: true });
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]).toMatchObject({ valid: true, errors: [] });
  });

  it('a pending state is not sent after a collect (the answer is the authority)', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme Ltd' });
    h.collect();
    await vi.advanceTimersByTimeAsync(STATE_DEBOUNCE_MS * 3);
    expect(h.ofType('state')).toHaveLength(0);
    expect(h.ofType('collected')).toHaveLength(1);
  });
});

describe('options (remote dropdowns)', () => {
  it('asks the parent for an empty dropdown\'s options with a fresh id, page 1 and no search', () => {
    const h = harness();
    h.init(remoteInit([dropdown(1, 'Category')]));
    const [request] = h.ofType('options.request');
    expect(request).toMatchObject({ type: 'options.request', fieldId: U(1), parentValue: null, page: 1, search: '' });
    expect(request!.id).toMatch(/^c-o-/);
  });

  it('the answer rebuilds the form with the options; more pages are asked for until hasMore is false', () => {
    const h = harness();
    h.init(remoteInit([dropdown(1, 'Category')]));
    const first = h.ofType('options.request')[0]!;
    h.send({ protocol: 'fp-bridge/2', type: 'options.result', replyTo: first.id, fieldId: U(1), options: [{ name: 'A', value: 'A' }], hasMore: true });
    const second = h.ofType('options.request')[1]!;
    expect(second).toMatchObject({ fieldId: U(1), page: 2 });
    expect(h.renders).toHaveLength(1);
    h.send({ protocol: 'fp-bridge/2', type: 'options.result', replyTo: second.id, fieldId: U(1), options: [{ name: 'B', value: 'B' }], hasMore: false });
    expect(h.renders).toHaveLength(2);
    expect(JSON.stringify(h.view().plan.version.definition.blocks[U(1) as never])).toContain('"B"');
  });

  it('an unknown replyTo, or an answer for another field, changes nothing', () => {
    const h = harness();
    h.init(remoteInit([dropdown(1, 'Category'), dropdown(2, 'Other')]));
    const [first] = h.ofType('options.request');
    h.send({ protocol: 'fp-bridge/2', type: 'options.result', replyTo: 'c-o-zzz', fieldId: U(1), options: [{ name: 'A', value: 'A' }], hasMore: false });
    h.send({ protocol: 'fp-bridge/2', type: 'options.result', replyTo: first!.id, fieldId: U(2), options: [{ name: 'A', value: 'A' }], hasMore: false });
    expect(h.renders).toHaveLength(1);
  });

  it('a dependent dropdown waits for its parent value, then asks with it (capped at 200 characters)', () => {
    const h = harness();
    h.init(remoteInit([dropdown(1, 'Category', { options: [{ name: 'Goods', value: 'Goods' }, { name: 'x'.repeat(250), value: 'x'.repeat(250) }] }), dropdown(2, 'City', { parent_field_id: U(1) })]));
    expect(h.ofType('options.request')).toHaveLength(0); // nothing to list until the parent has a value
    h.edit({ [U(1)]: 'Goods' });
    expect(h.ofType('options.request').at(-1)).toMatchObject({ fieldId: U(2), parentValue: 'Goods', page: 1 });
    h.edit({ [U(1)]: 'x'.repeat(250) });
    expect((h.ofType('options.request').at(-1) as { parentValue: string }).parentValue).toHaveLength(200);
  });
});

describe('dispose', () => {
  it('cancels a pending state', () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme Ltd' });
    h.controller.dispose();
    vi.advanceTimersByTime(1000);
    expect(h.ofType('state')).toHaveLength(0);
  });
});
