import { describe, expect, it } from 'vitest';
import { FormDefinitionSchema, type BlockId, type FieldBlock, type FormDefinition, type InlineDoc, type OptionId } from '@form/schema';
import { REGISTRY } from '../../src/index.ts';
import {
  DMS_V1_TILES, DMS_V1_TYPES, answerToDms, checkDmsV1, definitionToElements, dmsPhoneProblem, dmsToAnswer, elementsToDefinition, fnv1a64hex, isDmsV1Type, optionIdOf, parseDmsDate,
  type DmsElement,
} from '../../src/profiles/dms-v1/index.ts';
import fixtures from '../../src/profiles/dms-v1/__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };

const create = fixtures.create.request.form_builder_fields as DmsElement[];
const update = fixtures.update.request.form_builder_fields as DmsElement[];
const opts = { formId: 'form_1', title: 'Vendor', locale: 'en-IN' };

const inline = (text: string): InlineDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });
const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const issuesOf = (def: FormDefinition) => checkDmsV1(def);
const errorCodes = (def: FormDefinition) => issuesOf(def).filter((i) => i.severity === 'error').map((i) => i.code);
const withBlocks = (elements: DmsElement[]) => elementsToDefinition(elements, opts);
const el = (n: number, type: string, name: string, extra: Record<string, unknown> = {}): DmsElement => ({ id: uuid(n), type, name, value: name, label: name, required: false, placeholder: '', ...extra });

function mapDef(def: FormDefinition, fn: (block: FieldBlock) => FieldBlock): FormDefinition {
  const blocks = { ...def.blocks };
  for (const [id, b] of Object.entries(blocks)) if (b && 'compliance' in b) blocks[id as BlockId] = fn(b);
  return { ...def, blocks };
}

describe('fnv1a64hex', () => {
  it('matches the published FNV-1a 64 vectors', () => {
    expect(fnv1a64hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64hex('foobar')).toBe('85944171f73967e8');
  });
  it('hashes UTF-8 bytes and pads to 16 digits', () => {
    expect(fnv1a64hex('Zürich')).toMatch(/^[0-9a-f]{16}$/);
    expect(optionIdOf('Retail')).toBe(`v${fnv1a64hex('Retail')}`);
  });
});

describe('the seven types', () => {
  it('are the classic toolbox names, and the tiles are exactly those, in order', () => {
    expect(DMS_V1_TYPES).toEqual(['textinput', 'numberinput', 'email', 'phonenumber', 'multilineinput', 'dropdown', 'date']);
    expect(DMS_V1_TILES.map((t) => t.id)).toEqual([...DMS_V1_TYPES]);
    expect(DMS_V1_TILES.map((t) => t.label)).toEqual(['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date']);
    expect(isDmsV1Type('signature')).toBe(false);
    expect(isDmsV1Type('dropdown')).toBe(true);
  });
  it('every tile starts from a block the translator writes back as its own DMS type', () => {
    for (const tile of DMS_V1_TILES) {
      const config = { ...REGISTRY[tile.type].defaultConfig('en-IN' as never), ...tile.configOverrides };
      expect(REGISTRY[tile.type].configSchema.safeParse(config).success, tile.id).toBe(true);
      const def = withBlocks([]);
      const block = { id: uuid(1), type: tile.type, key: 'f_x', label: inline('Field'), required: false, compliance: { classification: 'none', purposeIds: [], encrypt: false, allowPrefill: true, inNotifications: 'include', inExports: 'include' }, config } as unknown as FieldBlock;
      const next: FormDefinition = { ...def, blocks: { [block.id]: block }, pages: [{ ...def.pages[0]!, children: [block.id] }] };
      expect(definitionToElements(next)[0]?.type, tile.id).toBe(tile.id);
      expect(issuesOf(next).filter((i) => i.severity === 'error' && i.code !== 'dropdown_no_options'), tile.id).toEqual([]);
    }
  });
});

describe('elementsToDefinition', () => {
  const def = withBlocks(create);

  it('produces a definition the v2 schema accepts, one page, every block config valid for its registry type', () => {
    const parsed = FormDefinitionSchema.safeParse(def);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    expect(def.pages).toHaveLength(1);
    expect(def.pages[0]!.children).toEqual(create.map((e) => e.id));
    for (const block of Object.values(def.blocks)) {
      if (block && block.type !== 'unsupported') expect(REGISTRY[block.type].configSchema.safeParse(block.config).success, block.type).toBe(true);
    }
  });

  it('matches the fixture blocks (formPlusBlocks)', () => {
    const expected = fixtures.formPlusBlocks.blocks;
    expect(expected).toHaveLength(7);
    for (const want of expected) {
      const block = def.blocks[want.id as BlockId] as FieldBlock;
      expect(block.key).toBe(want.key);
      expect(block.type).toBe(want.type);
      expect(block.required).toBe(want.required);
      expect(block.unique).toEqual('unique' in want ? want.unique : undefined);
      const { optionCodes, ...config } = want.config as Record<string, unknown> & { optionCodes?: string[] };
      expect(block.config).toMatchObject(config);
      if (optionCodes) {
        const options = (block.config as { options: Array<{ id: string; code: string; label: string }> }).options;
        expect(options.map((o) => o.code)).toEqual(optionCodes);
        expect(options.map((o) => o.id)).toEqual(optionCodes.map(optionIdOf));
      }
      expect((block as unknown as { x: Record<string, { type: string }> }).x['x-dms']?.type).toBe(create.find((e) => e.id === want.id)!.type);
    }
  });

  it('maps the four textinput character rules to the fixture patterns, in both directions', () => {
    for (const [rule, source] of Object.entries(fixtures.formPlusBlocks.textinputPatterns)) {
      const numeric = rule.includes('numeric=true');
      const specialChars = rule.includes('specialChars=true');
      const d = withBlocks([el(1, 'textinput', 'T', { numeric, specialChars })]);
      const block = d.blocks[uuid(1) as BlockId] as FieldBlock;
      expect((block.config as { pattern?: { source: string } }).pattern?.source).toBe(source ?? undefined);
      expect(definitionToElements(d)[0]).toMatchObject({ numeric, specialChars });
    }
  });

  it('keeps an element outside the seven as an unsupported block that goes back unchanged, and the guard refuses it', () => {
    const odd: DmsElement = { id: uuid(9), type: 'signature', name: 'Sign', weird: { a: 1 } };
    const d = withBlocks([create[0]!, odd]);
    expect(d.blocks[uuid(9) as BlockId]).toMatchObject({ type: 'unsupported', originalType: 'signature' });
    expect(definitionToElements(d)).toEqual([create[0], odd]);
    expect(errorCodes(d)).toContain('unsupported_block_type');
  });

  it('reads options from select.options, then options, and falls back to the name for a missing value', () => {
    const d1 = withBlocks([el(1, 'dropdown', 'D', { select: { options: [{ name: 'A', value: 'a' }] }, options: [{ name: 'B', value: 'b' }] })]);
    expect(definitionToElements(d1)[0]!.options).toEqual([{ name: 'A', value: 'a' }]);
    const d2 = withBlocks([el(1, 'dropdown', 'D', { options: [{ name: 'B' }, 'junk', { value: 7 }] })]);
    expect(definitionToElements(d2)[0]!.options).toEqual([{ name: 'B', value: 'B' }, { name: '7', value: '7' }]);
  });

  it('takes the first base page only, and keeps repeated ids once', () => {
    const d = withBlocks([create[0]!, create[0]!]);
    expect(d.pages[0]!.children).toHaveLength(1);
  });

  it('gives each block a unique key even when two ids collapse to the same text', () => {
    const d = withBlocks([el(1, 'email', 'A', { id: 'ID-1' }), el(2, 'email', 'B', { id: 'id1' })]);
    const keys = Object.values(d.blocks).map((b) => (b as FieldBlock).key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('round trip', () => {
  it('create fixture: elements -> definition -> elements is the identity', () => {
    expect(definitionToElements(withBlocks(create))).toEqual(create);
  });
  it('update fixture (rename, added option, added number) is the identity too', () => {
    expect(definitionToElements(withBlocks(update))).toEqual(update);
  });
  it('is stable on a second pass', () => {
    const once = definitionToElements(withBlocks(create));
    expect(definitionToElements(withBlocks(once))).toEqual(once);
  });
  it('carries increment settings, parent_field_id and unknown keys unchanged, and never writes autoIncrementValue back', () => {
    const e = el(1, 'textinput', 'Code', { numeric: true, specialChars: true, increment: true, incrementOption: 'suffix', prefix: 'P-', suffix: '-S', autoIncrementPattern: '000', autoIncrementValue: 42, parent_field_id: 'p1', custom: [1, 2] });
    const [out] = definitionToElements(withBlocks([e]));
    const { autoIncrementValue: _dropped, ...want } = e;
    expect(out).toEqual(want);
    expect(out).not.toHaveProperty('autoIncrementValue');
  });
  it('a key in x-dms cannot override what the block says', () => {
    const d = withBlocks([el(1, 'email', 'Mail', { required: true })]);
    const forged = mapDef(d, (b) => ({ ...b, required: false, x: { 'x-dms': { type: 'email', required: true, name: 'Evil', id: 'x' } } }) as unknown as FieldBlock);
    expect(definitionToElements(forged)[0]).toMatchObject({ id: uuid(1), name: 'Mail', required: false });
  });
  it('writes primary only for the allowed types', () => {
    const d = withBlocks([el(1, 'textinput', 'A', { primary: true }), el(2, 'dropdown', 'B', { primary: true, options: [{ name: 'x', value: 'x' }] })]);
    const out = definitionToElements(d);
    expect(out[0]!.primary).toBe(true);
    expect(out[1]).not.toHaveProperty('primary');
  });
  it('infers phonenumber from the config of a block with no x-dms (a fresh palette tile)', () => {
    const tile = DMS_V1_TILES.find((t) => t.id === 'phonenumber')!;
    const d = withBlocks([]);
    const block = { id: uuid(1), type: tile.type, key: 'f_p', label: inline('Mobile'), required: false, compliance: { classification: 'none', purposeIds: [], encrypt: false, allowPrefill: true, inNotifications: 'include', inExports: 'include' }, config: { ...tile.configOverrides } } as unknown as FieldBlock;
    const out = definitionToElements({ ...d, blocks: { [block.id]: block }, pages: [{ ...d.pages[0]!, children: [block.id] }] });
    expect(out[0]!.type).toBe('phonenumber');
  });
  it('the phonenumber tile is the real phone block, written back as phonenumber with its classic keys', () => {
    const tile = DMS_V1_TILES.find((t) => t.id === 'phonenumber')!;
    expect(tile.type).toBe('phone');
    expect(tile.configOverrides).toEqual({ defaultCountry: 'IN', showCountrySelect: true });
    const d = withBlocks([el(1, 'phonenumber', 'Mobile', { placeholder: 'Number', primary: true, column: 'text', extra: 1 })]);
    const block = d.blocks[uuid(1) as BlockId] as FieldBlock;
    expect(block.type).toBe('phone');
    expect(block.config).toEqual({ defaultCountry: 'IN', showCountrySelect: true, placeholder: 'Number' });
    expect(errorCodes(d)).toEqual([]);
    expect(issuesOf(d)).toEqual([]);
    expect(definitionToElements(d)[0]).toMatchObject({ id: uuid(1), type: 'phonenumber', name: 'Mobile', placeholder: 'Number', primary: true, column: 'text', extra: 1 });
  });
  it('a legacy short_text phone (10-digit pattern, x-dms phonenumber) still saves as phonenumber', () => {
    const d = withBlocks([el(1, 'phonenumber', 'Old')]);
    const old = mapDef(d, (b) => ({ ...b, type: 'short_text', config: { maxLength: 10, pattern: { source: '^[0-9]+$' } } }) as unknown as FieldBlock);
    expect(definitionToElements(old)[0]).toMatchObject({ type: 'phonenumber' });
    expect(issuesOf(old).filter((x) => x.code === 'config_dropped')).toEqual([]);
  });
  it('maps presets alphabetic/alphanumeric to the character rules', () => {
    const d = withBlocks([el(1, 'textinput', 'A'), el(2, 'textinput', 'B')]);
    const presets = ['alphabetic', 'alphanumeric'];
    let i = 0;
    const next = mapDef(d, (b) => ({ ...b, config: { preset: presets[i++] } }) as unknown as FieldBlock);
    expect(definitionToElements(next).map((x) => [x.numeric, x.specialChars])).toEqual([[false, false], [true, false]]);
  });
});

describe('checkDmsV1', () => {
  const clean = withBlocks(create);

  it('finds nothing in the fixture form', () => {
    expect(issuesOf(clean)).toEqual([]);
  });

  it('error: more than one page', () => {
    const d = { ...clean, pages: [...clean.pages, { id: 'page_2' as never, children: [] }] };
    expect(errorCodes(d)).toContain('too_many_pages');
  });

  it.each([
    ['rule', (d: FormDefinition) => ({ ...d, logic: { ...d.logic, rules: [{} as never] } })],
    ['rule group', (d: FormDefinition) => ({ ...d, logic: { ...d.logic, ruleGroups: [{} as never] } })],
    ['variable', (d: FormDefinition) => ({ ...d, logic: { ...d.logic, variables: [{} as never] } })],
  ])('error: logic (%s)', (_name, edit) => {
    expect(errorCodes(edit(clean))).toContain('logic_not_supported');
  });

  it('error: a block type outside the seven (paste, template, AI insert all land here), including content blocks', () => {
    const heading = { id: 'h1' as BlockId, type: 'heading', config: { text: inline('Hi'), level: 2 } } as never;
    const calc = { ...(clean.blocks[uuid(0) as BlockId] ?? {}), id: 'c1' as BlockId, type: 'calculation' } as never;
    const withHeading = { ...clean, blocks: { ...clean.blocks, h1: heading }, pages: [{ ...clean.pages[0]!, children: [...clean.pages[0]!.children, 'h1' as BlockId] }] };
    expect(errorCodes(withHeading)).toContain('unsupported_block_type');
    const withCalc = { ...clean, blocks: { ...clean.blocks, c1: calc } };
    expect(errorCodes(withCalc)).toContain('unsupported_block_type');
    const phone = { ...clean, blocks: { ...clean.blocks, p1: { id: 'p1', type: 'url', key: 'p1', label: inline('P'), required: false, compliance: {}, config: {} } as never } };
    expect(errorCodes(phone)).toContain('unsupported_block_type');
  });

  it('error: a block id that is not a uuid', () => {
    const d = withBlocks([el(1, 'email', 'Mail', { id: 'not-a-uuid' })]);
    expect(errorCodes(d)).toContain('block_id_not_uuid');
  });

  it('error: empty, too long and duplicate (case-insensitive, trimmed) names', () => {
    expect(errorCodes(withBlocks([el(1, 'email', '  ')]))).toContain('label_empty');
    expect(errorCodes(withBlocks([el(1, 'email', 'x'.repeat(256))]))).toContain('label_too_long');
    const dup = withBlocks([el(1, 'email', 'Name'), el(2, 'textinput', ' name ')]);
    expect(errorCodes(dup)).toContain('label_duplicate');
  });

  it('error: more than one primary, and primary on a long text, dropdown or date', () => {
    expect(errorCodes(withBlocks([el(1, 'email', 'A', { primary: true }), el(2, 'textinput', 'B', { primary: true })]))).toContain('multiple_primary');
    for (const [type, extra] of [['multilineinput', {}], ['dropdown', { options: [{ name: 'x', value: 'x' }] }], ['date', {}]] as const) {
      const d = withBlocks([el(1, type, 'F', extra)]);
      const flagged = mapDef(d, (b) => ({ ...b, unique: { normalize: 'exact' } }) as FieldBlock);
      expect(errorCodes(flagged), type).toContain('primary_not_allowed');
    }
  });

  it('error: a dropdown with no options, an empty option, a repeated option value', () => {
    expect(errorCodes(withBlocks([el(1, 'dropdown', 'D', { options: [] })]))).toContain('dropdown_no_options');
    expect(errorCodes(withBlocks([el(1, 'dropdown', 'D', { options: [{ name: ' ', value: ' ' }] })]))).toContain('option_empty');
    expect(errorCodes(withBlocks([el(1, 'dropdown', 'D', { options: [{ name: 'A', value: 'a' }, { name: 'B', value: 'a' }] })]))).toContain('option_duplicate');
  });

  it('error: no fields at all', () => {
    expect(errorCodes(withBlocks([]))).toContain('no_fields');
  });

  it('warning (not error): config DMS cannot keep, listed by name', () => {
    const d = withBlocks([el(1, 'email', 'Mail'), el(2, 'date', 'When'), el(3, 'numberinput', 'N'), el(4, 'dropdown', 'D', { options: [{ name: 'a', value: 'a' }] })]);
    const next = mapDef(d, (b) => {
      const config = b.type === 'email' ? { ...b.config, confirm: true, allowedDomains: ['x.com'] }
        : b.type === 'date' ? { ...b.config, pattern: 'YYYY-MM-DD', defaultValue: { kind: 'fixed', date: '2026-01-01' } }
          : b.type === 'number' ? { ...b.config, min: '0', step: '5' }
            : { ...b.config, display: 'radio', shuffle: false };
      return { ...b, config, readOnly: true, description: { type: 'doc', content: [{ type: 'paragraph' }] } } as unknown as FieldBlock;
    });
    const warnings = issuesOf(next).filter((i) => i.severity === 'warning');
    expect(errorCodes(next)).toEqual([]);
    const config = warnings.filter((w) => w.code === 'config_dropped').map((w) => w.message);
    expect(config).toHaveLength(4);
    expect(config.join('\n')).toMatch(/confirm, allowedDomains/);
    expect(config.join('\n')).toMatch(/pattern, defaultValue/);
    expect(config.join('\n')).toMatch(/min, step/);
    expect(config.join('\n')).toMatch(/display, shuffle/);
    expect(warnings.filter((w) => w.code === 'settings_dropped')).toHaveLength(4);
  });

  it('warns about a custom pattern, a phone number with another length, a preset DMS cannot enforce', () => {
    const d = withBlocks([el(1, 'textinput', 'A'), el(2, 'phonenumber', 'P'), el(3, 'textinput', 'C')]);
    const patterns = [{ pattern: { source: '^x+$' } }, { maxLength: 12, pattern: { source: '^[0-9]+$' } }, { preset: 'in_pan' }];
    let i = 0;
    const next = mapDef(d, (b) => ({ ...b, config: patterns[i++] }) as unknown as FieldBlock);
    expect(issuesOf(next).filter((x) => x.code === 'config_dropped')).toHaveLength(3);
  });
});

describe('answers', () => {
  const def = withBlocks(create);
  const block = (n: number) => def.blocks[`b1000000-0000-4000-8000-00000000000${n}` as BlockId] as FieldBlock;

  it('parses both DMS date formats and rejects days that do not exist', () => {
    expect(parseDmsDate('05-03-2026')).toBe('2026-03-05');
    expect(parseDmsDate('2026-03-05')).toBe('2026-03-05');
    expect(parseDmsDate('31-02-2026')).toBeUndefined();
    expect(parseDmsDate('29-02-2024')).toBe('2024-02-29');
    expect(parseDmsDate('00-01-2026')).toBeUndefined();
    expect(parseDmsDate('13/01/2026')).toBeUndefined();
    expect(parseDmsDate('2026-13-01')).toBeUndefined();
  });

  it('round-trips each of the seven value shapes', () => {
    const cases: Array<[number, string, unknown]> = [
      [1, 'Acme Traders', 'Acme Traders'],
      [2, '42', '42'],
      [3, 'sales@acme.example', { address: 'sales@acme.example' }],
      [4, '9876543210', { e164: '+919876543210', country: 'IN' }],
      [5, 'Line 1\nLine 2', 'Line 1\nLine 2'],
      [6, 'Retail', { optionId: optionIdOf('Retail') }],
      [7, '05-03-2026', '2026-03-05'],
    ];
    for (const [n, dms, answer] of cases) {
      expect(dmsToAnswer(block(n), dms), `to ${n}`).toEqual(answer);
      expect(answerToDms(block(n), answer as never), `from ${n}`).toBe(dms);
    }
  });

  it('phone: reads and writes the digits-only DMS string', () => {
    const IN = (n: string) => ({ e164: `+91${n}`, country: 'IN' });
    // India: national digits only, both ways
    expect(dmsToAnswer(block(4), '9876543210')).toEqual(IN('9876543210'));
    expect(answerToDms(block(4), IN('9876543210') as never)).toBe('9876543210');
    // stored with the code or a plus: stripped, then the length decides
    expect(dmsToAnswer(block(4), '+919876543210')).toEqual(IN('9876543210'));
    expect(dmsToAnswer(block(4), '919876543210')).toEqual(IN('9876543210'));
    expect(dmsToAnswer(block(4), '+91 98765-43210')).toEqual(IN('9876543210'));
    expect(dmsToAnswer(block(4), '98765')).toEqual(IN('98765'));
    // other countries keep the calling code, no plus
    expect(dmsToAnswer(block(4), '12025550123')).toEqual({ e164: '+12025550123', country: 'US' });
    expect(dmsToAnswer(block(4), '+442071838750')).toEqual({ e164: '+442071838750', country: 'GB' });
    expect(dmsToAnswer(block(4), '971501234567')).toEqual({ e164: '+971501234567', country: 'AE' });
    expect(answerToDms(block(4), { e164: '+12025550123', country: 'US' } as never)).toBe('12025550123');
    expect(answerToDms(block(4), { e164: '+442071838750', country: 'GB' } as never)).toBe('442071838750');
    // blank and junk
    expect(answerToDms(block(4), { e164: '', country: 'IN' } as never)).toBe('');
    expect(answerToDms(block(4), undefined)).toBe('');
    expect(dmsToAnswer(block(4), 'abc')).toBeUndefined();
    expect(dmsToAnswer(block(4), '+')).toBeUndefined();
    expect(dmsToAnswer(block(4), '1234567890123456')).toBeUndefined();
    expect(dmsToAnswer(block(4), '00000000000')).toBeUndefined();
  });

  it('phone: DMS limits (India 10 digits, elsewhere 4 to 15)', () => {
    expect(dmsPhoneProblem({ e164: '+919876543210', country: 'IN' } as never)).toBeNull();
    expect(dmsPhoneProblem({ e164: '+98765', country: 'IN' } as never)).not.toBeNull();
    expect(dmsPhoneProblem({ e164: '+12025550123', country: 'US' } as never)).toBeNull();
    expect(dmsPhoneProblem({ e164: '+123', country: 'US' } as never)).not.toBeNull();
    expect(dmsPhoneProblem({ e164: '+1234567890123456', country: 'US' } as never)).not.toBeNull();
    expect(dmsPhoneProblem({ e164: '', country: 'IN' } as never)).toBeNull();
  });

  it('writes a date given as YYYY-MM-DD back as DD-MM-YYYY', () => {
    expect(answerToDms(block(7), dmsToAnswer(block(7), '2026-03-05') as never)).toBe('05-03-2026');
  });

  it('treats empty, unknown or malformed values as unanswered', () => {
    for (let n = 1; n <= 7; n += 1) expect(dmsToAnswer(block(n), ''), `${n}`).toBeUndefined();
    expect(dmsToAnswer(block(2), '4.5')).toBeUndefined();
    expect(dmsToAnswer(block(2), '-0')).toBeUndefined();
    expect(dmsToAnswer(block(6), 'Nonexistent')).toBeUndefined();
    expect(dmsToAnswer(block(7), 'tomorrow')).toBeUndefined();
    for (let n = 1; n <= 7; n += 1) expect(answerToDms(block(n), undefined), `${n}`).toBe('');
  });

  it('matches a dropdown by option name when the value is not a code, and gives "" for an unknown option id or "Other"', () => {
    const d = withBlocks([el(1, 'dropdown', 'D', { options: [{ name: 'Big', value: 'B' }] })]);
    const b = d.blocks[uuid(1) as BlockId] as FieldBlock;
    expect(dmsToAnswer(b, 'Big')).toEqual({ optionId: optionIdOf('B') });
    expect(answerToDms(b, { optionId: 'nope' as OptionId })).toBe('');
    expect(answerToDms(b, { optionId: null, other: 'x' })).toBe('');
  });

  it('answers of a block type outside the seven are unanswered', () => {
    const other = { type: 'rating', config: {} } as unknown as FieldBlock;
    expect(dmsToAnswer(other, '3')).toBeUndefined();
    expect(answerToDms(other, 3 as never)).toBe('');
  });
});
