import { describe, expect, it } from 'vitest';
import type { BlockId, FieldBlock, StoredBlock } from '@form/schema';
import fixtures from './__fixtures__/classic-to-dms-v1.fixtures.json' with { type: 'json' };
import { checkDmsV1, definitionToElements, elementsToDefinition, xWithVisibility, type DmsElement } from './index.ts';
import { xDms } from './shared.ts';

/*
 * DT-09 (DESIGN 8 golden semantics, SEC-DESIGN 8.2, 5.3): a classic-native master converted by `formplus:migrate-openform --classic`
 * keeps its json_data byte for byte, and the dms-v1 profile must carry it the same way. Every golden element is loaded into the profile
 * and saved back: each classic-only key survives (advanced_rules, parent_field_id, increment*, prefix/suffix, numeric/specialChars,
 * is_primary, isDefaultToDate), keys the profile does not model ride in `x-dms` read-only (the block never reads them back as settings),
 * and the hidden/secret flags are first-class keys that round-trip as booleans.
 *
 * Canonical fixture: this package's __fixtures__ (byte-identical copy in dms-api); the file is the contract, never edited here.
 */

const opts = { formId: 'form_dt09', title: 'Golden', locale: 'en-IN' };
/*
 * A classic element has `label` and `value` but no `name`; fORM- writes the OpenForm mirror key `name` next to them (DESIGN 8, dialect rules of
 * facts/form-embed.md 2.9). Round trip therefore means: every key the element had comes back with its value, and the only keys that may
 * appear are the dialect's own (below). Nothing is dropped, nothing a classic reader would trip over is added.
 */
const DIALECT_KEYS = new Set(['name', 'select', 'value', 'label', 'required', 'placeholder', 'isDefaultToDate', 'numeric', 'specialChars']);

type Case = { name: string; covers: string[]; input: DmsElement; expected: { element: DmsElement }; note?: string };
type MasterCase = { name: string; elements: DmsElement[]; expected: { action: string; elements?: DmsElement[]; blocked?: Array<{ reason: string }> } };
const elementCases = fixtures.elementCases as unknown as Case[];
const masterCases = fixtures.masterCases as unknown as MasterCase[];

/** `saved` carries every key of `input` with the same value, and adds only dialect keys. */
function expectKept(saved: DmsElement | undefined, input: DmsElement, label: string): void {
  expect(saved, label).toBeDefined();
  expect(saved, label).toMatchObject(input as Record<string, unknown>);
  const added = Object.keys(saved!).filter((k) => !(k in input));
  expect(added.filter((k) => !DIALECT_KEYS.has(k)), `${label}: keys added that are not the dialect's`).toEqual([]);
}

const roundTrip = (elements: DmsElement[]) => definitionToElements(elementsToDefinition(elements, opts));
const blocksOf = (elements: DmsElement[]) => Object.values(elementsToDefinition(elements, opts).blocks) as StoredBlock[];

describe('classic-to-dms-v1 golden: element cases (DT-09)', () => {
  it('covers the seven classic types and every classic-only key the fixture names', () => {
    const types = new Set(elementCases.map((c) => c.input.type));
    for (const t of fixtures.classicTypes) expect(types, `type ${t}`).toContain(t);
    const keys = new Set(elementCases.flatMap((c) => Object.keys(c.input)));
    for (const k of ['advanced_rules', 'parent_field_id', 'increment', 'incrementOption', 'isDefaultToDate', 'prefix', 'suffix', 'numeric', 'specialChars', 'is_primary', 'primary']) {
      expect(keys, `key ${k}`).toContain(k);
    }
  });

  it.each(elementCases.map((c) => [c.name, c] as const))('%s: loads into the profile and saves back with every key kept', (_name, c) => {
    expect(c.expected.element, 'the fixture says the element is kept as it is').toEqual(c.input);
    const saved = roundTrip([c.input]);
    expect(saved).toHaveLength(1);
    expectKept(saved[0], c.input, c.name);
  });

  it('every golden element together keeps its order and every key', () => {
    const all = elementCases.map((c) => c.input);
    const saved = roundTrip(all);
    expect(saved.map((e) => e.id)).toEqual(all.map((e) => e.id));
    all.forEach((el, i) => expectKept(saved[i], el, el.id));
  });

  it('loading is not saving: a second pass over the saved elements changes nothing (idempotent)', () => {
    const once = roundTrip(elementCases.map((c) => c.input));
    expect(roundTrip(once)).toEqual(once);
    expect(roundTrip(roundTrip(once))).toEqual(once);
  });

  it('a block never carries a classic-only key as a setting: it rides in x-dms and the block keys stay the profile\'s own', () => {
    const carried = ['advanced_rules', 'parent_field_id', 'increment', 'incrementOption', 'prefix', 'suffix', 'autoIncrementPattern', 'is_primary'];
    for (const c of elementCases) {
      const [block] = blocksOf([c.input]) as FieldBlock[];
      const dms = xDms(block as StoredBlock);
      for (const k of carried) {
        if (k in c.input) expect(dms[k], `${c.name}: ${k} rides in x-dms`).toEqual((c.input as Record<string, unknown>)[k]);
        expect(k in (block as unknown as Record<string, unknown>), `${c.name}: ${k} is not a block key`).toBe(false);
      }
    }
  });

  it('modelled keys are not duplicated into x-dms (a key in x-dms cannot override what the block says)', () => {
    for (const c of elementCases) {
      const [block] = blocksOf([c.input]);
      const dms = xDms(block as StoredBlock);
      for (const k of ['id', 'name', 'value', 'label', 'required', 'placeholder', 'primary', 'numeric', 'specialChars', 'isDefaultToDate', 'options', 'select']) expect(dms, `${c.name}: ${k}`).not.toHaveProperty(k);
    }
  });

  it('the dms-v1 guard accepts every golden element (no error stops a classic master from saving)', () => {
    const def = elementsToDefinition(
      elementCases.map((c) => c.input),
      opts,
    );
    expect(checkDmsV1(def).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a renamed field keeps its classic-only keys: only name, value and label follow the new label', () => {
    const input = elementCases.find((c) => c.name === 'textinput-increment-prefix')!.input;
    const def = elementsToDefinition([input], opts);
    const [id] = Object.keys(def.blocks) as BlockId[];
    const block = def.blocks[id!] as FieldBlock;
    const renamed = { ...def, blocks: { ...def.blocks, [id!]: { ...block, label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vendor Number' }] }] } } } } as typeof def;
    const [saved] = definitionToElements(renamed);
    expect(saved).toMatchObject({ name: 'Vendor Number', value: 'Vendor Number', label: 'Vendor Number', increment: true, incrementOption: 'prefix', prefix: 'VND-', autoIncrementPattern: 4 });
  });
});

describe('classic-to-dms-v1 golden: hidden and secret are first-class x-dms keys (SEC 5.3)', () => {
  const plain = elementCases.find((c) => c.name === 'hidden-and-secret-properties-kept')!;

  it('the fixture keeps is_hidden/is_secret in the master field properties only, so the element carries neither key and none is invented', () => {
    expect(plain.input).not.toHaveProperty('is_hidden');
    expect(plain.input).not.toHaveProperty('is_secret');
    const saved = roundTrip([plain.input])[0]!;
    expectKept(saved, plain.input, plain.name);
    expect(saved).not.toHaveProperty('is_hidden');
    expect(saved).not.toHaveProperty('is_secret');
  });

  it('flags the server sends on an element come back unchanged, as booleans', () => {
    const sent: DmsElement = { ...plain.input, is_hidden: false, is_secret: true };
    expectKept(roundTrip([sent])[0], sent, 'flagged');
    const [block] = blocksOf([sent]);
    expect(xDms(block as StoredBlock)).toMatchObject({ is_hidden: false, is_secret: true });
  });

  it('numeric and string flags are normalised once on load; null is "not set" and is not written back', () => {
    const odd = { ...plain.input, is_hidden: 1, is_secret: 'false' } as unknown as DmsElement;
    expect(roundTrip([odd])[0]).toMatchObject({ is_hidden: true, is_secret: false });
    const nulls = { ...plain.input, is_hidden: null, is_secret: null } as unknown as DmsElement;
    const saved = roundTrip([nulls])[0]!;
    expect(saved).not.toHaveProperty('is_hidden');
    expect(saved).not.toHaveProperty('is_secret');
  });

  it('the inspector helper writes both flags together and leaves every other x and x-dms key alone', () => {
    const input = elementCases.find((c) => c.name === 'textinput-increment-prefix')!.input;
    const def = elementsToDefinition([input], opts);
    const [id] = Object.keys(def.blocks) as BlockId[];
    const block = def.blocks[id!] as FieldBlock;
    const withX = { ...block, x: { 'x-other': { keep: 1 }, ...(block as unknown as { x: object }).x } } as unknown as FieldBlock;
    const next = { ...withX, x: xWithVisibility(withX, { secret: true }) } as unknown as FieldBlock;
    const out = definitionToElements({ ...def, blocks: { ...def.blocks, [id!]: next } })[0]!;
    expect(out).toMatchObject({ is_hidden: false, is_secret: true, increment: true, prefix: 'VND-' });
    expect((next as unknown as { x: Record<string, unknown> }).x['x-other']).toEqual({ keep: 1 });
  });

  it('guard: a primary field that is hidden or secret is an error; the same flags on a plain field are not', () => {
    const primary = elementCases.find((c) => c.name === 'textinput-primary')!.input;
    for (const flag of ['is_hidden', 'is_secret'] as const) {
      const issues = checkDmsV1(elementsToDefinition([{ ...primary, [flag]: true }], opts));
      expect(issues.filter((i) => i.severity === 'error').map((i) => i.code), flag).toContain('primary_cannot_be_hidden');
    }
    expect(checkDmsV1(elementsToDefinition([{ ...primary, is_hidden: false, is_secret: false }], opts)).filter((i) => i.severity === 'error')).toEqual([]);
    const plainFlagged = checkDmsV1(elementsToDefinition([{ ...plain.input, is_hidden: true, is_secret: true }], opts));
    expect(plainFlagged.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('classic-to-dms-v1 golden: master cases', () => {
  const converted = masterCases.filter((c) => c.expected.action === 'converted_classic');

  it.each(converted.map((c) => [c.name, c] as const))('%s: the converted elements load and save back unchanged, and the guard passes', (_name, c) => {
    const kept = c.expected.elements!;
    const saved = roundTrip(kept);
    expect(saved.map((e) => e.id)).toEqual(kept.map((e) => e.id));
    kept.forEach((el, i) => expectKept(saved[i], el, `${c.name}: ${el.id}`));
    expect(checkDmsV1(elementsToDefinition(kept, opts)).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a master the converter blocks is refused by the guard for the same reasons (duplicate name, empty name, an element type outside the seven)', () => {
    const codes = (name: string) => checkDmsV1(elementsToDefinition(masterCases.find((c) => c.name === name)!.elements, opts)).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes('duplicate-names-blocked')).toContain('label_duplicate');
    expect(codes('empty-name-blocked')).toContain('label_empty');
    expect(codes('unsupported-element-owning-a-column-blocked')).toContain('unsupported_block_type');
  });

  it('an element type outside the seven comes back raw (never rewritten) when the block is not touched', () => {
    const qrcode = masterCases.find((c) => c.name === 'unsupported-element-owning-a-column-blocked')!.elements;
    const saved = roundTrip(qrcode);
    const raw = qrcode.find((e) => e.type === 'qrcode')!;
    expect(saved.find((e) => e.id === raw.id)).toEqual(raw);
  });
});
