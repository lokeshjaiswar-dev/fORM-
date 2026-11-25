import { describe, expect, it } from 'vitest';
import type { BlockId, FieldBlock, FormDefinition } from '@form/schema';
import {
  checkDmsV1, definitionToElements, elementsToDefinition, isLegacyReadOnly, legacyOfBlock, legacyOfElement, type DmsElement,
} from '../../src/profiles/dms-v1/index.ts';
import fx from '../../src/profiles/dms-v1/__fixtures__/openform-to-dms-v1.fixtures.json' with { type: 'json' };

const opts = { formId: 'form_1', title: 'Legacy', locale: 'en-IN' };
const cases = fx.elementCases as unknown as Array<{ name: string; expected: { element: DmsElement } }>;
const legacyCases = cases.filter((c) => c.expected.element.legacy !== undefined);
const blockOf = (el: DmsElement) => {
  const def = elementsToDefinition([el], opts);
  return { def, block: def.blocks[el.id as BlockId] as FieldBlock };
};
const mutate = (def: FormDefinition, id: string, patch: Record<string, unknown>): FormDefinition =>
  ({ ...def, blocks: { ...def.blocks, [id]: { ...def.blocks[id as BlockId], ...patch } } }) as FormDefinition;

describe('legacy marker', () => {
  it('has fixtures to cover', () => expect(legacyCases.length).toBeGreaterThanOrEqual(6));

  it('reads a well-formed marker from an element and rejects malformed ones', () => {
    const base = { id: 'a', type: 'multilineinput', name: 'A' };
    expect(legacyOfElement({ ...base, legacy: { from: 'files', readOnly: true } })).toEqual({ from: 'files', readOnly: true });
    expect(legacyOfElement(base)).toBeNull();
    expect(legacyOfElement({ ...base, legacy: { from: 'files', readOnly: false } })).toBeNull();
    expect(legacyOfElement({ ...base, legacy: { from: '', readOnly: true } })).toBeNull();
    expect(legacyOfElement({ ...base, legacy: { readOnly: true } })).toBeNull();
    expect(legacyOfElement({ ...base, legacy: 'files' })).toBeNull();
    expect(legacyOfElement({ ...base, legacy: [] })).toBeNull();
  });

  it.each(legacyCases.map((c) => [c.name, c] as const))('%s: marker rides x-dms and the element survives unchanged', (_n, c) => {
    const { block } = blockOf(c.expected.element);
    expect(legacyOfBlock(block)).toEqual(c.expected.element.legacy);
    expect(isLegacyReadOnly(block)).toBe(true);
  });

  it('non-legacy blocks are not read-only', () => {
    const plain = cases.find((c) => c.expected.element.legacy === undefined)!;
    expect(isLegacyReadOnly(blockOf(plain.expected.element).block)).toBe(false);
  });
});

describe('every openform fixture element survives elementsToDefinition -> definitionToElements', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const def = elementsToDefinition([c.expected.element], opts);
    expect(definitionToElements(def)).toEqual([c.expected.element]);
  });
  it('all together, in order', () => {
    const els = cases.map((c) => c.expected.element);
    expect(definitionToElements(elementsToDefinition(els, opts))).toEqual(els);
  });
});

describe('guard: legacy read-only', () => {
  const el = legacyCases.find((c) => c.name === 'files')!.expected.element;
  const codes = (def: FormDefinition) => checkDmsV1(def).filter((i) => i.severity === 'error').map((i) => i.code);

  it('is clean when the legacy block is optional and not primary', () => {
    expect(codes(blockOf(el).def)).toEqual([]);
  });
  it('LEGACY_READ_ONLY_REQUIRED when required', () => {
    const { def } = blockOf(el);
    expect(codes(mutate(def, el.id, { required: true }))).toContain('LEGACY_READ_ONLY_REQUIRED');
  });
  it('LEGACY_READ_ONLY_PRIMARY when primary, without a second primary_not_allowed', () => {
    const { def } = blockOf(el);
    const got = codes(mutate(def, el.id, { unique: { normalize: 'exact' } }));
    expect(got).toContain('LEGACY_READ_ONLY_PRIMARY');
    expect(got).not.toContain('primary_not_allowed');
  });
  it('a text-typed legacy field (button) cannot be primary either', () => {
    const btn = legacyCases.find((c) => c.name === 'pan-button')!.expected.element;
    const { def } = blockOf(btn);
    expect(codes(mutate(def, btn.id, { unique: { normalize: 'exact' } }))).toEqual(['LEGACY_READ_ONLY_PRIMARY']);
  });
  it('a non-legacy multiline field may not be primary (unchanged rule)', () => {
    const { def } = blockOf({ id: 'c0000000-0000-4000-8000-000000000001', type: 'multilineinput', name: 'N' });
    expect(codes(mutate(def, 'c0000000-0000-4000-8000-000000000001', { unique: { normalize: 'exact' } }))).toContain('primary_not_allowed');
  });
});
