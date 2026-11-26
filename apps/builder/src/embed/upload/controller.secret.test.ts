import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_MASK } from '../lookup/dmsRows.ts';
import type { InitMessage } from '../bridge/protocolV2.ts';
import { STATE_DEBOUNCE_MS } from './controller.ts';
import { F, harness, v2Init } from './v2Harness.ts';

/*
 * T-60, upload part (SEC-DESIGN 5.3, 10.3 row 60): a secret field is never prefilled, an untouched one is absent from `collected.values`,
 * and the mask string is never sent. The init is the contract's edit-mode fixture: Tax Id (secret) is stored and masked
 * (`values[taxId] = null`, `masked: [taxId]`).
 */

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);
const everything = (h: ReturnType<typeof harness>) => JSON.stringify(h.sent);

describe('a masked secret on init', () => {
  it('is never prefilled: the form starts without an answer for it, and says "Stored (hidden)"', () => {
    const h = harness();
    h.init();
    expect(h.view().plan.initialAnswers).not.toHaveProperty(F.taxId);
    const block = h.view().plan.version.definition.blocks[F.taxId as never] as { config?: { placeholder?: unknown }; placeholder?: unknown };
    expect(JSON.stringify(block)).toContain('Stored (hidden)');
  });

  it('is never prefilled even if a (non-conforming) parent put a value in init.values', async () => {
    const h = harness();
    const init = { ...v2Init(), values: { ...v2Init().values, [F.taxId]: 'hunter2' }, masked: [] as string[] } as InitMessage;
    h.init(init);
    expect(h.view().plan.initialAnswers).not.toHaveProperty(F.taxId);
    h.collect();
    await flush();
    expect(everything(h)).not.toContain('hunter2');
    expect(h.ofType('collected')[0]!.values).not.toHaveProperty(F.taxId);
  });

  it('untouched, it is absent from collected.values and the collect is still valid', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme Ltd' }); // another field
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    // state says so too: the secret is not among the touched ids
    expect(h.ofType('state').at(-1)!.touched).toEqual([F.vendorName]);
    h.collect();
    await flush();
    const collected = h.ofType('collected')[0]!;
    expect(collected.values).not.toHaveProperty(F.taxId);
    expect(collected.values[F.vendorName]).toBe('Acme Ltd');
    expect(collected.valid).toBe(true);
  });

  it('typed into, it is sent back once, in collected, and listed as touched in state (ids only)', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.taxId]: 'ABCDE12345' });
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    const state = h.ofType('state').at(-1)!;
    expect(state.touched).toEqual([F.taxId]);
    expect(JSON.stringify(state)).not.toContain('ABCDE12345');
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.values[F.taxId]).toBe('ABCDE12345');
    expect(JSON.stringify(h.sent.filter((m) => m.type !== 'collected'))).not.toContain('ABCDE12345');
  });

  it('typed into and cleared again, it is sent as an empty string (the person replaced a stored value with nothing)', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.taxId]: 'ABC123' });
    h.edit({ [F.taxId]: '' });
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.values[F.taxId]).toBe('');
  });

  it('the mask string is never sent, even if the person types it into the field', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.taxId]: SECRET_MASK });
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.values).not.toHaveProperty(F.taxId);
    expect(everything(h)).not.toContain(SECRET_MASK);
  });

  it('a required masked field is satisfied by the stored value, and required again once the person starts replacing it', async () => {
    const init = v2Init();
    init.masterFields = init.masterFields.map((e) => (e.id === F.taxId ? { ...e, required: true } : e));
    const h = harness();
    h.init(init);
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.valid).toBe(true);
    h.edit({ [F.taxId]: 'A1' });
    h.edit({ [F.taxId]: '' });
    h.collect('r4nd0m-req-0000000002');
    await flush();
    expect(h.ofType('collected')[1]!.errors).toEqual([{ fieldId: F.taxId, code: 'required', message: expect.any(String) }]);
  });
});

describe('a secret field with no stored value (create mode)', () => {
  const create = (): InitMessage => {
    const init = v2Init();
    return { ...init, values: { [F.vendorName]: 'Acme' }, masked: [], context: { mode: 'create', today: '26-11-2026' } };
  };

  it('untouched, it is absent from collected.values', async () => {
    const h = harness();
    h.init(create());
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.values).not.toHaveProperty(F.taxId);
  });

  it('typed into, it is sent', async () => {
    const h = harness();
    h.init(create());
    h.edit({ [F.taxId]: 'XYZ99' });
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.values[F.taxId]).toBe('XYZ99');
  });

  it('required and empty, it is reported as required', async () => {
    const init = create();
    init.masterFields = init.masterFields.map((e) => (e.id === F.taxId ? { ...e, required: true } : e));
    const h = harness();
    h.init(init);
    h.collect();
    await flush();
    expect(h.ofType('collected')[0]!.errors.map((e) => `${e.fieldId}:${e.code}`)).toContain(`${F.taxId}:required`);
  });
});

describe('nothing of the stored secret exists in the child', () => {
  it('no message of a whole session mentions the mask or a secret value', async () => {
    const h = harness();
    h.init();
    h.edit({ [F.vendorName]: 'Acme Ltd', [F.category]: 'Services' });
    vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
    h.collect();
    await flush();
    expect(everything(h)).not.toContain(SECRET_MASK);
    expect(everything(h)).not.toContain('__masked');
  });
});
