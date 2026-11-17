import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { definition, id, ids, inline } from './fixtures.ts';

let n = 0;
const newId = () => id(`m_${(n += 1)}`);

function input(formId: string, title: string, patch: (def: S.FormDefinition) => void): S.MergeFormInput {
  const def = definition();
  def.formId = id<S.FormId>(formId);
  def.title = title;
  patch(def);
  return { id: formId, title, definition: def };
}

function merge(forms: S.MergeFormInput[], resolutions?: S.MergeResolution[]) {
  n = 0;
  return S.mergeForms(forms, { newFormId: 'grouped', newId, ...(resolutions ? { resolutions } : {}) });
}

function nameOf(def: S.FormDefinition): S.FieldBlockOf<'short_text'> {
  return def.blocks[ids.name] as S.FieldBlockOf<'short_text'>;
}

function fields(def: S.FormDefinition): S.FieldBlock[] {
  return Object.values(def.blocks).filter(S.isFieldBlock);
}

function byLabel(def: S.FormDefinition, label: string): S.FieldBlock | undefined {
  return fields(def).find((b) => S.normalizeLabel(S.plainLabelText(b.label)) === S.normalizeLabel(label));
}

describe('mergeForms matching', () => {
  it('merges the same plain label and type into one field', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      nameOf(def).id = id('name_b');
      def.pages[0]!.children = [ids.consent, id('name_b')];
      def.blocks[id<S.BlockId>('name_b')] = nameOf(def);
      delete def.blocks[ids.name];
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fields(result.definition).filter((f) => f.type === 'short_text' && S.plainLabelText(f.label) === 'Your name')).toHaveLength(1);
    expect(result.definition.formId).toBe('grouped');
    expect(result.definition.title).toBe('A + B');
  });

  it('treats labels as equal after trim, case and extra spaces', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      nameOf(def).label = inline('  YOUR   NAME ');
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fields(result.definition).filter((f) => f.type === 'short_text')).toHaveLength(1);
  });

  it('does not merge different labels', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      nameOf(def).label = inline('Other name');
      nameOf(def).key = id('other_name');
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(byLabel(result.definition, 'Your name')).toBeTruthy();
    expect(byLabel(result.definition, 'Other name')).toBeTruthy();
  });

  it('does not merge the same label with a different type', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      const name = nameOf(def);
      def.blocks[ids.name] = {
        ...name,
        type: 'email',
        key: id('email'),
        config: {},
      } as S.FieldBlockOf<'email'>;
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fields(result.definition).some((f) => f.type === 'short_text' && S.plainLabelText(f.label) === 'Your name')).toBe(true);
    expect(fields(result.definition).some((f) => f.type === 'email' && S.plainLabelText(f.label) === 'Your name')).toBe(true);
  });

  it('copies headings instead of merging them', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', () => undefined);
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.values(result.definition.blocks).filter((b): b is S.StoredBlock => b !== undefined && b.type === 'heading')).toHaveLength(2);
  });
});

describe('mergeForms combining', () => {
  it('keeps required if either field is required', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).required = false;
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).required = true;
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nameOf(result.definition).required).toBe(true);
  });

  it('takes a pattern when only one side has it', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { ...nameOf(def).config, pattern: { source: '^[A-Za-z]+$' } };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nameOf(result.definition).config.pattern).toEqual({ source: '^[A-Za-z]+$' });
  });

  it('takes the stricter length bounds', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { minLength: 3, maxLength: 20 };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { minLength: 5, maxLength: 10 };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nameOf(result.definition).config).toMatchObject({ minLength: 5, maxLength: 10 });
  });

  it('keeps matching choice options as one field', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      const m = def.blocks[ids.marketing] as S.FieldBlockOf<'single_choice'>;
      m.config.options = [
        { id: id('y2'), label: 'Yes' },
        { id: id('n2'), label: 'No' },
      ];
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fields(result.definition).filter((f) => f.type === 'single_choice')).toHaveLength(1);
  });

  it('appends unmatched fields and keeps unique keys', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      const extra: S.FieldBlockOf<'email'> = {
        id: id('email_b'),
        type: 'email',
        key: id('name'),
        label: inline('Work email'),
        required: false,
        compliance: nameOf(def).compliance,
        config: {},
      };
      def.blocks[extra.id] = extra;
      def.pages[0]!.children.push(extra.id);
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = fields(result.definition).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(byLabel(result.definition, 'Work email')?.key).not.toBe('name');
  });
});

describe('mergeForms conflicts', () => {
  it('conflicts when patterns differ', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { pattern: { source: '^[A-Z]+$' } };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { pattern: { source: '^[0-9]+$' } };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]).toMatchObject({ reason: 'config.pattern', type: 'short_text' });
    expect(result.conflicts[0]!.sides).toHaveLength(2);
  });

  it('conflicts when full_name parts differ', () => {
    const name = (parts: S.NamePart[], idn: string): S.FieldBlockOf<'full_name'> => ({
      id: id(idn),
      type: 'full_name',
      key: id('full'),
      label: inline('Applicant name'),
      required: false,
      compliance: nameOf(definition()).compliance,
      config: { parts, requiredParts: ['first'] },
    });
    const a = input('a', 'Form A', (def) => {
      def.blocks[id<S.BlockId>('fn')] = name(['prefix', 'first', 'middle', 'last'], 'fn');
      def.pages[0]!.children.push(id('fn'));
    });
    const b = input('b', 'Form B', (def) => {
      def.blocks[id<S.BlockId>('fn')] = name(['first', 'last', 'suffix', 'middle'], 'fn');
      def.pages[0]!.children.push(id('fn'));
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts.some((c) => c.reason === 'config.parts')).toBe(true);
  });

  it('conflicts when choice lists differ', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      const m = def.blocks[ids.marketing] as S.FieldBlockOf<'single_choice'>;
      m.config.options = [
        { id: id('y2'), label: 'Yes' },
        { id: id('maybe'), label: 'Maybe' },
      ];
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.options');
  });

  it('conflicts when length bounds cannot overlap', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { minLength: 10, maxLength: 20 };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { minLength: 1, maxLength: 5 };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.bounds');
  });

  it('conflicts when uniqueness rules differ', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).unique = { normalize: 'exact' };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).unique = { normalize: 'trim_lower' };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.unique');
  });

  it('conflicts when the same label+type appears twice in one form', () => {
    const a = input('a', 'A', (def) => {
      def.blocks[id<S.BlockId>('name2')] = { ...nameOf(def), id: id('name2'), key: id('name_2') };
      def.pages[0]!.children.push(id('name2'));
    });
    const b = input('b', 'B', () => undefined);
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('duplicate_in_source');
  });

  it('conflicts when two payment fields would remain', () => {
    const pay = (blockId: string, label: string): S.FieldBlockOf<'payment'> => ({
      id: id(blockId),
      type: 'payment',
      key: id(`pay_${blockId}`),
      label: inline(label),
      required: true,
      compliance: { ...nameOf(definition()).compliance, classification: 'none', purposeIds: [] },
      config: {
        gateway: 'razorpay',
        currency: id('INR'),
        amount: { kind: 'donation', suggested: [id('10000')], min: id('10000'), allowCustom: false },
        couponsEnabled: false,
        showTotal: true,
        holdUntilPaid: true,
      },
    });
    const a = input('a', 'A', (def) => {
      def.blocks[id<S.BlockId>('pay_a')] = pay('pay_a', 'Fee A');
      def.pages[0]!.children.push(id('pay_a'));
    });
    const b = input('b', 'B', (def) => {
      def.blocks[id<S.BlockId>('pay_b')] = pay('pay_b', 'Fee B');
      def.pages[0]!.children.push(id('pay_b'));
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts.some((c) => c.reason === 'payment')).toBe(true);
  });

  it('conflicts when both forms set the same field to different values', () => {
    const setRule = (ruleId: string, target: S.BlockId, text: string): S.Rule => ({
      id: id(ruleId),
      enabled: true,
      when: { kind: 'group', id: id(`${ruleId}_g`), combinator: 'all', children: [] },
      then: [{ type: 'set_value', target, value: { k: 'lit', value: { type: 'text', value: text } } }],
    });
    const a = input('a', 'A', (def) => {
      def.logic.rules.push(setRule('set_a', ids.name, 'alpha'));
    });
    const b = input('b', 'B', (def) => {
      def.logic.rules.push(setRule('set_b', ids.name, 'beta'));
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts.some((c) => c.reason === 'logic.set_value')).toBe(true);
  });
});

describe('mergeForms resolutions', () => {
  it('uses the chosen form’s field after a conflict', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { pattern: { source: '^[A-Z]+$' } };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { pattern: { source: '^[0-9]+$' } };
    });
    const blocked = merge([a, b]);
    expect(blocked.ok).toBe(false);
    const result = merge([a, b], [{ label: 'Your name', type: 'short_text', chosenFormId: 'b' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(nameOf(result.definition).config.pattern).toEqual({ source: '^[0-9]+$' });
  });

  it('needs at least two forms', () => {
    const result = merge([input('a', 'A', () => undefined)]);
    expect(result.ok).toBe(false);
  });
});

describe('mergeForms extra clashes', () => {
  it('conflicts when radio vs dropdown display differs', () => {
    const a = input('a', 'A', () => undefined);
    const b = input('b', 'B', (def) => {
      (def.blocks[ids.marketing] as S.FieldBlockOf<'single_choice'>).config.display = 'dropdown';
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.display');
  });

  it('conflicts when error messages for the same code differ', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).messages = { required: 'Please fill this' };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).messages = { required: 'This is required' };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.messages');
  });

  it('conflicts when presets differ', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { preset: 'in_pan' };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { preset: 'in_gstin' };
    });
    const result = merge([a, b]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0]?.reason).toBe('config.preset');
  });

  it('keeps the same pattern when both sides match', () => {
    const a = input('a', 'A', (def) => {
      nameOf(def).config = { pattern: { source: '^[A-Z]+$' } };
    });
    const b = input('b', 'B', (def) => {
      nameOf(def).config = { pattern: { source: '^[A-Z]+$' } };
    });
    expect(merge([a, b]).ok).toBe(true);
  });
});

describe('mergeForms configurable list', () => {
  function listForm(title: string, childLabel: string): S.MergeFormInput {
    return input(title.toLowerCase(), title, (def) => {
      const child: S.FieldBlockOf<'short_text'> = {
        id: id('item_name'),
        type: 'short_text',
        key: id('item_name'),
        label: inline(childLabel),
        required: false,
        compliance: nameOf(def).compliance,
        config: {},
      };
      const list: S.FieldBlockOf<'repeating_group'> = {
        id: id('list_1'),
        type: 'repeating_group',
        key: id('items'),
        label: inline('Items'),
        required: false,
        compliance: { ...nameOf(def).compliance, classification: 'none', purposeIds: [] },
        config: { children: [child.id], minRows: 1, maxRows: 10, layout: 'stacked' },
      };
      def.blocks[child.id] = child;
      def.blocks[list.id] = list;
      def.pages = [{ id: ids.page1, children: [ids.name, list.id] }];
    });
  }

  it('keeps a configurable list and its fields on the same page, not as a page break', () => {
    const a = input('a', 'A', (def) => {
      def.pages = [{ id: ids.page1, children: [ids.name] }];
    });
    const b = listForm('B', 'Row title');
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lists = Object.values(result.definition.blocks).filter((block): block is S.StoredBlock => block !== undefined && block.type === 'repeating_group');
    expect(lists).toHaveLength(1);
    const list = lists[0] as S.FieldBlockOf<'repeating_group'>;
    expect(list.config.children.length).toBe(1);
    expect(result.definition.blocks[list.config.children[0]!]?.type).toBe('short_text');
    expect(result.definition.pages).toHaveLength(1);
    expect(result.definition.pages[0]!.children).toContain(list.id);
  });

  it('does not fold a list child into a same-named field on the page', () => {
    const a = input('a', 'A', (def) => {
      def.pages = [{ id: ids.page1, children: [ids.name] }];
    });
    const b = listForm('B', 'Your name');
    const result = merge([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = Object.values(result.definition.blocks).find((block): block is S.StoredBlock => block !== undefined && block.type === 'repeating_group') as S.FieldBlockOf<'repeating_group'>;
    expect(list.config.children).toHaveLength(1);
    expect(list.config.children[0]).not.toBe(ids.name);
  });
});
