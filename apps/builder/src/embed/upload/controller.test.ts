import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dmsToAnswer } from '@form/registry/profiles/dms-v1';
import type { AnswerValue, Answers, BlockId, FieldBlock } from '@form/schema';
import { categoryOptions, fixtures, initPayload } from '../bridge/fixtures.ts';
import { parseMessage, type BridgeMessage, type InboundMessage, type InitPayload, type OutboundType, type PayloadOf } from '../bridge/protocol.ts';
import { UploadController, type RenderView } from './controller.ts';

/* The child's behaviour behind the wire, driven message by message against the contract fixtures. */

const OPTION_FIELD = 'a1000000-0000-4000-8000-000000000006';
const INVOICE_DATE = 'd1000000-0000-4000-8000-000000000007';
const INVOICE_NO = 'd1000000-0000-4000-8000-000000000001';

interface Sent { type: OutboundType; id: string; replyTo?: string; payload: unknown }

function harness(extra: { showInlineErrors?: () => Promise<unknown> } = {}) {
  const sent: Sent[] = [];
  const renders: Array<RenderView | null> = [];
  let n = 0;
  const controller = new UploadController({
    send: (type, payload: PayloadOf<OutboundType>, replyTo) => {
      n += 1;
      const message: Sent = { type, id: `c-${n}`, ...(replyTo ? { replyTo } : {}), payload };
      // Every message the child sends must be valid on the wire.
      expect(parseMessage({ protocol: 'fp-bridge/1', ...message }).ok, `${type} ${JSON.stringify(payload).slice(0, 200)}`).toBe(true);
      sent.push(message);
      return message.id;
    },
    onRender: (v) => void renders.push(v),
    ...extra,
  });
  const view = () => renders.at(-1)!;
  const ofType = (type: OutboundType) => sent.filter((m) => m.type === type);
  const init = (payload: InitPayload, id = 'p-init-1') => controller.receive({ protocol: 'fp-bridge/1', type: 'init', id, payload });
  const validate = (id = 'p-val-1') => controller.receive({ protocol: 'fp-bridge/1', type: 'validate', id, payload: {} });
  const options = (request: Sent, list: Array<{ name: string; value: string }>, hasMore = false, fieldId?: string) =>
    controller.receive({ protocol: 'fp-bridge/1', type: 'options.result', id: `p-${request.id}`, replyTo: request.id, payload: { fieldId: fieldId ?? (request.payload as { fieldId: string }).fieldId, options: list, hasMore } } as InboundMessage);
  /** The renderer's answers after the person set `edits` (DMS strings) on top of what the current view started with. */
  const edit = (edits: Record<string, string>, raw: Record<string, AnswerValue | null> = {}) => {
    const answers: Record<string, AnswerValue> = { ...(view().plan.initialAnswers as Record<string, AnswerValue>) };
    for (const [id, text] of Object.entries(edits)) {
      const block = view().plan.version.definition.blocks[id as BlockId] as FieldBlock;
      const value = dmsToAnswer(block, text);
      if (value === undefined) delete answers[id];
      else answers[id] = { type: block.type, value } as AnswerValue;
    }
    for (const [id, a] of Object.entries(raw)) {
      if (a === null) delete answers[id];
      else answers[id] = a;
    }
    controller.setAnswers(answers as Answers);
  };
  return { controller, sent, renders, view, ofType, init, validate, options, edit };
}

const asInit = (m: BridgeMessage) => (m as Extract<BridgeMessage, { type: 'init' }>).payload;
const validatedOf = (c: (typeof fixtures.cases)[number]) => c.expectedValidated.payload;
const byFieldAndCode = (errors: Array<{ fieldId: string; code: string }>) => errors.map((e) => `${e.fieldId}:${e.code}`).sort();

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('fixture: valid create', () => {
  const valid = fixtures.cases[0]!;

  it('init -> initialized(14, none); options requested for the empty master dropdown; edits -> change; validate -> validated', async () => {
    const h = harness();
    h.init(initPayload());
    expect(h.ofType('initialized')[0]).toMatchObject({ replyTo: 'p-init-1', payload: { fieldCount: 14, unsupported: [] } });
    expect(h.ofType('options.request')).toHaveLength(1);
    expect(h.ofType('options.request')[0]!.payload).toEqual({ fieldId: OPTION_FIELD, parentValue: null, page: 1, search: '' });

    h.options(h.ofType('options.request')[0]!, categoryOptions);
    expect(h.renders).toHaveLength(2); // the dropdown was rebuilt with its options
    h.edit(valid.userInput);
    vi.advanceTimersByTime(149);
    expect(h.ofType('change')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.ofType('change')).toHaveLength(1);
    expect(h.ofType('change')[0]!.payload).toEqual(valid.expectedChange!.payload);

    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const validated = h.ofType('validated')[0]!;
    expect(validated.replyTo).toBe('p-val-1');
    expect(validated.payload).toEqual(validatedOf(valid));
  });

  it('the starting form: two titled sections, the increment field read-only with its next number, no value for it', () => {
    const h = harness();
    h.init(initPayload());
    const def = h.view().plan.version.definition;
    const titles = def.pages[0]!.children.map((id) => JSON.stringify(def.blocks[id]));
    expect(titles[0]).toContain('Document details');
    expect(titles[1]).toContain('Master details');
    expect(h.view().plan.initialAnswers[INVOICE_NO as BlockId]).toEqual({ type: 'short_text', value: 'INV-0007' });
    expect((def.blocks[INVOICE_NO as BlockId] as FieldBlock).readOnly).toBe(true);
    h.validate();
    return vi.advanceTimersByTimeAsync(0).then(() => {
      const values = (h.ofType('validated')[0]!.payload as { values: Record<string, string> }).values;
      expect(Object.keys(values)).toHaveLength(13);
      expect(values).not.toHaveProperty(INVOICE_NO);
      expect(values[INVOICE_DATE]).toBe('24-11-2026'); // default to today, from the parent's clock
      expect(values['a1000000-0000-4000-8000-000000000007']).toBe('01-04-2026'); // YYYY-MM-DD in, DD-MM-YYYY out
    });
  });
});

describe('fixture: invalid', () => {
  it('reports exactly the expected (field, code) pairs and the values as typed', async () => {
    const invalid = fixtures.cases[1]!;
    const h = harness();
    const init = initPayload();
    // The person's input reaches the child as a record already holding it (an edit of a stored record).
    init.values = { ...init.values, ...invalid.userInput };
    h.init(init);
    h.options(h.ofType('options.request')[0]!, categoryOptions);
    h.validate('p-val-2');
    await vi.advanceTimersByTimeAsync(0);
    const got = h.ofType('validated')[0]!;
    const want = validatedOf(invalid);
    expect(got.replyTo).toBe('p-val-2');
    const payload = got.payload as typeof want;
    expect(payload.valid).toBe(false);
    expect(byFieldAndCode(payload.errors)).toEqual(byFieldAndCode(want.errors));
    expect(payload.values).toEqual(want.values);
  });

  it('typed through the form: a fractional number and a bad email are kept as typed and reported', async () => {
    const h = harness();
    h.init(initPayload());
    h.edit({ 'a1000000-0000-4000-8000-000000000001': 'Acme', 'a1000000-0000-4000-8000-000000000003': 'bad@' }, {
      ['d1000000-0000-4000-8000-000000000002']: { type: 'number', value: '12.5' } as AnswerValue,
    });
    vi.advanceTimersByTime(150);
    expect((h.ofType('change')[0]!.payload as { valid: boolean }).valid).toBe(false);
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const payload = h.ofType('validated')[0]!.payload as { errors: Array<{ fieldId: string; code: string }>; values: Record<string, string> };
    expect(payload.values['d1000000-0000-4000-8000-000000000002']).toBe('12.5');
    expect(byFieldAndCode(payload.errors)).toEqual([
      'a1000000-0000-4000-8000-000000000003:invalid_email',
      'd1000000-0000-4000-8000-000000000002:not_integer',
      'd1000000-0000-4000-8000-000000000006:required',
    ]);
  });
});

describe('unsupported types', () => {
  it('answers initialized with the unsupported ids and shows nothing', () => {
    const h = harness();
    h.init(asInit(fixtures.unsupported.init), 'p-init-unsup');
    const want = (fixtures.unsupported.expectedInitialized as Extract<BridgeMessage, { type: 'initialized' }>).payload;
    expect(h.ofType('initialized')[0]).toMatchObject({ replyTo: 'p-init-unsup', payload: want });
    expect(h.view()).toBeNull();
    expect(h.ofType('options.request')).toHaveLength(0);
  });

  it('a later init with supported fields shows the form again', () => {
    const h = harness();
    h.init(asInit(fixtures.unsupported.init));
    h.init(initPayload());
    expect(h.view()).not.toBeNull();
  });
});

describe('re-init', () => {
  it('is idempotent: the same init gives the same form, values and answers, and the old options request is dead', async () => {
    const h = harness();
    h.init(initPayload(), 'p-init-1');
    const first = h.ofType('options.request')[0]!;
    const before = h.view();
    h.init(initPayload(), 'p-init-2');
    expect(h.ofType('initialized').map((m) => [m.replyTo, m.payload])).toEqual([
      ['p-init-1', { fieldCount: 14, unsupported: [] }],
      ['p-init-2', { fieldCount: 14, unsupported: [] }],
    ]);
    expect(h.view().plan.initialAnswers).toEqual(before.plan.initialAnswers);
    expect(h.view().plan.baseline).toEqual(before.plan.baseline);
    // The first request answered late changes nothing; the second one is live.
    const rendersBefore = h.renders.length;
    h.options(first, [{ name: 'Old', value: 'Old' }]);
    expect(h.renders).toHaveLength(rendersBefore);
    h.options(h.ofType('options.request')[1]!, [{ name: 'Wholesale', value: 'Wholesale' }]);
    expect(h.renders).toHaveLength(rendersBefore + 1);
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ofType('validated')).toHaveLength(1);
  });

  it('replaces everything: edits made after the first init are gone, a pending change is never sent', async () => {
    const h = harness();
    h.init(initPayload());
    h.edit({ 'a1000000-0000-4000-8000-000000000001': 'Zed' });
    h.init({ ...initPayload(), values: {} });
    vi.advanceTimersByTime(1000);
    expect(h.ofType('change')).toHaveLength(0);
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const values = (h.ofType('validated')[0]!.payload as { values: Record<string, string> }).values;
    expect(values['a1000000-0000-4000-8000-000000000001']).toBe('');
  });

  it('an init that is not usable (a field id twice) is a fatal invalid_init and clears the form', () => {
    const h = harness();
    h.init(initPayload());
    const bad = initPayload();
    bad.masterFields[0] = { ...bad.masterFields[0]!, id: bad.doctypeFields[0]!.id };
    h.init(bad);
    expect(h.ofType('error')[0]!.payload).toMatchObject({ code: 'invalid_init', fatal: true });
    expect(h.view()).toBeNull();
  });
});

describe('validate', () => {
  it('before any init: a non-fatal internal error, no verdict', async () => {
    const h = harness();
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ofType('validated')).toHaveLength(0);
    expect(h.ofType('error')[0]!.payload).toMatchObject({ code: 'internal', fatal: false });
  });

  it('flushes the pending change first, so the parent caches the latest values', async () => {
    const h = harness();
    h.init(initPayload());
    h.edit({ 'a1000000-0000-4000-8000-000000000001': 'Zed' });
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent.map((m) => m.type).slice(-2)).toEqual(['change', 'validated']);
    vi.advanceTimersByTime(1000);
    expect(h.ofType('change')).toHaveLength(1);
  });

  it('shows the inline errors, but a hung renderer cannot hold the verdict past the timeout', async () => {
    const show = vi.fn(() => new Promise<unknown>(() => undefined));
    const h = harness({ showInlineErrors: show });
    h.init(initPayload());
    h.validate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(show).toHaveBeenCalledTimes(1);
    expect(h.ofType('validated')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.ofType('validated')).toHaveLength(1);
  });

  it('a read-only form never reports errors', async () => {
    const h = harness();
    h.init({ ...initPayload(), readOnly: true });
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ofType('validated')[0]!.payload).toMatchObject({ valid: true, errors: [] });
    const blocks = h.view().plan.version.definition.blocks;
    expect((blocks['d1000000-0000-4000-8000-000000000002' as BlockId] as FieldBlock).readOnly).toBe(true);
    expect((blocks['d1000000-0000-4000-8000-000000000002' as BlockId] as FieldBlock).required).toBe(false);
  });

  it('an answer that did not change leaves the string DMS sent untouched (an unrepresentable date stays as sent)', async () => {
    const h = harness();
    const init = initPayload();
    init.values = { 'a1000000-0000-4000-8000-000000000007': '31-02-2026' };
    h.init(init);
    h.edit({ 'a1000000-0000-4000-8000-000000000001': 'Acme' });
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const payload = h.ofType('validated')[0]!.payload as { errors: Array<{ code: string }>; values: Record<string, string> };
    expect(payload.values['a1000000-0000-4000-8000-000000000007']).toBe('31-02-2026');
    expect(payload.errors.map((e) => e.code)).toContain('invalid_date');
  });
});

describe('increment fields', () => {
  it('create: never in values or errors; edit: shows the stored value, still not in values', async () => {
    const h = harness();
    h.init({ ...initPayload(), context: { mode: 'edit', today: '24-11-2026' }, values: { [INVOICE_NO]: 'INV-0003' } });
    expect(h.view().plan.initialAnswers[INVOICE_NO as BlockId]).toEqual({ type: 'short_text', value: 'INV-0003' });
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const payload = h.ofType('validated')[0]!.payload as { errors: Array<{ fieldId: string }>; values: Record<string, string> };
    expect(payload.values).not.toHaveProperty(INVOICE_NO);
    expect(payload.errors.map((e) => e.fieldId)).not.toContain(INVOICE_NO);
  });
});

describe('remote dropdown options', () => {
  const FIELD = 'a1000000-0000-4000-8000-000000000006';

  it('pages until hasMore is false', () => {
    const h = harness();
    h.init(initPayload());
    h.options(h.ofType('options.request')[0]!, [{ name: 'A', value: 'A' }], true);
    expect(h.ofType('options.request').map((m) => (m.payload as { page: number }).page)).toEqual([1, 2]);
    h.options(h.ofType('options.request')[1]!, [{ name: 'B', value: 'B' }, { name: 'A', value: 'A' }], false);
    expect(h.ofType('options.request')).toHaveLength(2);
    const cfg = h.view().plan.version.definition.blocks[FIELD as BlockId] as FieldBlock & { config: { options: Array<{ code?: string }> } };
    expect(cfg.config.options.map((o) => o.code)).toEqual(['A', 'B']);
  });

  it('stops asking at the 500-option demo cap', () => {
    const h = harness();
    h.init(initPayload());
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ name: `n${from + i}`, value: `v${from + i}` }));
    h.options(h.ofType('options.request')[0]!, page(0, 300), true);
    h.options(h.ofType('options.request')[1]!, page(300, 300), true);
    expect(h.ofType('options.request')).toHaveLength(2);
    const blocks = h.view().plan.version.definition.blocks[FIELD as BlockId] as FieldBlock & { config: { options: unknown[] } };
    expect(blocks.config.options).toHaveLength(500);
  });

  it('ignores a result for another field than the one asked about, and one nobody asked for', () => {
    const h = harness();
    h.init(initPayload());
    const rendersBefore = h.renders.length;
    h.options(h.ofType('options.request')[0]!, [{ name: 'A', value: 'A' }], false, 'a1000000-0000-4000-8000-000000000005');
    h.options({ id: 'nobody', type: 'options.request', payload: { fieldId: FIELD } }, [{ name: 'A', value: 'A' }]);
    expect(h.renders).toHaveLength(rendersBefore);
  });

  it('keeps a stored choice that the loaded options contain, and clears one they do not', async () => {
    const h = harness();
    const init = initPayload();
    init.values = { [FIELD]: 'Retail' };
    h.init(init);
    h.options(h.ofType('options.request')[0]!, [{ name: 'Retail', value: 'Retail' }]);
    expect(h.view().plan.initialAnswers[FIELD as BlockId]).toMatchObject({ type: 'single_choice' });
    const h2 = harness();
    h2.init(init);
    h2.options(h2.ofType('options.request')[0]!, [{ name: 'Wholesale', value: 'Wholesale' }]);
    expect(h2.view().plan.initialAnswers[FIELD as BlockId]).toBeUndefined();
    vi.advanceTimersByTime(150);
    expect((h2.ofType('change')[0]!.payload as { values: Record<string, string> }).values[FIELD]).toBe('');
  });

  describe('a dropdown that depends on another', () => {
    const PARENT = 'a1000000-0000-4000-8000-000000000008';
    const CHILD = 'a1000000-0000-4000-8000-000000000009';
    const dependent = (values: Record<string, string> = {}): InitPayload => ({
      ...initPayload(),
      doctypeFields: [],
      masterFields: [
        { id: PARENT, type: 'dropdown', label: '', value: 'Country', required: false, options: [{ name: 'IN', value: 'IN' }, { name: 'US', value: 'US' }], field_source: 'master' },
        { id: CHILD, type: 'dropdown', label: '', value: 'State', required: false, options: [], parent_field_id: PARENT, field_source: 'master' },
      ],
      values,
    });

    it('asks nothing until the parent has a value, then asks with it, and again when it changes (the stale answer is ignored)', () => {
      const h = harness();
      h.init(dependent());
      expect(h.ofType('options.request')).toHaveLength(0);
      h.edit({ [PARENT]: 'IN' });
      const first = h.ofType('options.request')[0]!;
      expect(first.payload).toEqual({ fieldId: CHILD, parentValue: 'IN', page: 1, search: '' });
      h.edit({ [PARENT]: 'US' });
      expect(h.ofType('options.request')[1]!.payload).toMatchObject({ parentValue: 'US' });
      const rendersBefore = h.renders.length;
      h.options(first, [{ name: 'MH', value: 'MH' }]);
      expect(h.renders).toHaveLength(rendersBefore);
      h.options(h.ofType('options.request')[1]!, [{ name: 'CA', value: 'CA' }]);
      expect(h.renders).toHaveLength(rendersBefore + 1);
    });

    it('asks at init when the parent already has a value, and clears the child when the parent is emptied', () => {
      const h = harness();
      h.init(dependent({ [PARENT]: 'IN', [CHILD]: 'MH' }));
      expect(h.ofType('options.request')[0]!.payload).toMatchObject({ fieldId: CHILD, parentValue: 'IN' });
      h.options(h.ofType('options.request')[0]!, [{ name: 'MH', value: 'MH' }]);
      expect(h.view().plan.initialAnswers[CHILD as BlockId]).toMatchObject({ type: 'single_choice' });
      h.edit({ [PARENT]: '' });
      expect(h.view().plan.initialAnswers[CHILD as BlockId]).toBeUndefined();
      vi.advanceTimersByTime(150);
      expect((h.ofType('change').at(-1)!.payload as { values: Record<string, string> }).values[CHILD]).toBe('');
    });
  });
});

describe('dispose', () => {
  it('cancels the pending change', () => {
    const h = harness();
    h.init(initPayload());
    h.edit({ 'a1000000-0000-4000-8000-000000000001': 'Zed' });
    h.controller.dispose();
    vi.advanceTimersByTime(1000);
    expect(h.ofType('change')).toHaveLength(0);
  });
});

describe('legacy read-only fields (converted from OpenForm)', () => {
  const LEGACY = 'c2000000-0000-4000-8000-000000000017';
  const STORED = '[{"name":"a.pdf"}]';
  const withLegacy = (over: Record<string, unknown> = {}) => {
    const init = initPayload();
    init.masterFields = [...init.masterFields, { id: LEGACY, type: 'multilineinput', name: 'Docs', value: 'Docs', label: 'Docs', required: true, primary: true, placeholder: '', legacy: { from: 'files', readOnly: true }, ...over } as never];
    init.values = { ...init.values, [LEGACY]: STORED };
    return init;
  };

  it('renders the stored string read-only, never required, and still supported (no fallback)', () => {
    const h = harness();
    h.init(withLegacy());
    expect(h.ofType('initialized')[0]!.payload).toMatchObject({ fieldCount: 15, unsupported: [] });
    const block = h.view().plan.version.definition.blocks[LEGACY as BlockId] as FieldBlock;
    expect(block.readOnly).toBe(true);
    expect(block.required).toBe(false);
    expect(block.unique).toBeUndefined();
    expect(h.view().plan.initialAnswers[LEGACY as BlockId]).toEqual({ type: 'long_text', value: STORED });
  });

  it('is never in change or validated values, never validated, and an edit elsewhere does not report it', async () => {
    const h = harness();
    h.init(withLegacy());
    h.options(h.ofType('options.request')[0]!, categoryOptions);
    h.edit(fixtures.cases[0]!.userInput);
    vi.advanceTimersByTime(150);
    expect(Object.keys((h.ofType('change')[0]!.payload as { values: Record<string, string> }).values)).not.toContain(LEGACY);
    // A renderer answer for the legacy block (changed, or removed) is ignored.
    h.edit(fixtures.cases[0]!.userInput, { [LEGACY]: { type: 'long_text', value: 'tampered' } as AnswerValue });
    h.edit(fixtures.cases[0]!.userInput, { [LEGACY]: null });
    vi.advanceTimersByTime(150);
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    const validated = h.ofType('validated')[0]!.payload as { valid: boolean; errors: Array<{ fieldId: string }>; values: Record<string, string> };
    expect(validated.valid).toBe(true);
    expect(validated.errors.map((e) => e.fieldId)).not.toContain(LEGACY);
    expect(validated.values).not.toHaveProperty(LEGACY);
    for (const c of h.ofType('change')) expect((c.payload as { values: Record<string, string> }).values).not.toHaveProperty(LEGACY);
  });

  it('a legacy field with no stored value shows empty and is still not required', async () => {
    const h = harness();
    const init = withLegacy();
    delete (init.values as Record<string, string>)[LEGACY];
    h.init(init);
    expect(h.view().plan.initialAnswers[LEGACY as BlockId]).toBeUndefined();
    h.options(h.ofType('options.request')[0]!, categoryOptions);
    h.edit(fixtures.cases[0]!.userInput);
    h.validate();
    await vi.advanceTimersByTimeAsync(0);
    expect((h.ofType('validated')[0]!.payload as { valid: boolean }).valid).toBe(true);
  });
});
