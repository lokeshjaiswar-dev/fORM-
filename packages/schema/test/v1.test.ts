import { describe, expect, it } from 'vitest';
import { parseV1, V1 } from '../src/index.ts';

const v1Form = {
  id: 'contact',
  title: 'Contact us',
  description: 'We reply within a day.',
  blocks: [
    { id: 'b1', type: 'heading', label: 'Contact', order: 0 },
    { id: 'b2', type: 'text', label: 'Name', placeholder: 'Jane', validation: { required: true }, order: 1 },
    {
      id: 'b3', type: 'multiple_choice', label: 'Topic', order: 2,
      options: [{ id: 'o1', label: 'Sales', value: 'sales' }, { id: 'o2', label: 'Support', value: 'support' }],
      logic: { enabled: true, action: 'show', sourceBlockId: 'b2', operator: 'answered' },
      customize: { width: 'half', besidePrevious: true },
    },
  ],
  settings: { ...V1.DEFAULT_SETTINGS, submitButtonText: 'Send' },
};

describe('parseV1', () => {
  it('accepts a clean v1 form unchanged', () => {
    const result = parseV1(v1Form);
    expect(result).toEqual({ success: true, data: v1Form, repairs: [] });
    expect(V1.FormSchemaSchema.parse(v1Form)).toEqual(v1Form);
  });

  it('repairs what it can and reports every repair', () => {
    const result = parseV1({
      title: 'Old save',
      blocks: [
        { id: 'a', type: 'email', label: 'Email', order: 0, helpText: 7, extra: true },
        { id: 'b', type: 'carousel', label: 'Gone', order: 1 },
        { type: 'text', label: 'No id' },
        { id: 'a', type: 'text', label: 'Duplicate', order: 2 },
        { id: 'c', type: 'dropdown', options: [{ id: 'x', label: 'X' }, 'junk'], validation: { min: '3', max: 5 }, logic: { operator: 'between' } },
        'not a block',
      ],
      settings: { submitButtonText: 'Go', closed: 'yes' },
    });
    if (!result.success) throw new Error(result.error);
    expect(result.data.blocks).toEqual([
      { id: 'a', type: 'email', label: 'Email', order: 0 },
      { id: 'c', type: 'dropdown', label: '', order: 4, options: [{ id: 'x', label: 'X', value: 'X' }], validation: { max: 5 }, logic: {} },
    ]);
    expect(result.data.settings).toEqual({ ...V1.DEFAULT_SETTINGS, submitButtonText: 'Go' });
    expect(result.data.id).toBe('');
    expect(result.repairs).toEqual(expect.arrayContaining([
      { path: '/blocks/0/helpText', reason: 'invalid_value' },
      { path: '/blocks/0/extra', reason: 'unknown_key' },
      { path: '/blocks/1/type', reason: 'unknown_type' },
      { path: '/blocks/2/id', reason: 'missing_id' },
      { path: '/blocks/3/id', reason: 'duplicate_id' },
      { path: '/blocks/4/options/0/value', reason: 'defaulted' },
      { path: '/blocks/4/options/1', reason: 'invalid_value' },
      { path: '/blocks/4/validation/min', reason: 'invalid_value' },
      { path: '/blocks/4/logic/operator', reason: 'invalid_value' },
      { path: '/blocks/5', reason: 'not_an_object' },
      { path: '/settings/closed', reason: 'invalid_value' },
      { path: '/id', reason: 'defaulted' },
    ]));
    expect(V1.V1ParseResultSchema.safeParse(result).success).toBe(true);
  });

  it('reports every unknown key it drops and every option value it fills in', () => {
    const result = parseV1(JSON.parse(JSON.stringify({
      id: 'f', title: 't', description: '', theme: 'dark',
      blocks: [{
        id: 'a', type: 'dropdown', label: 'A', order: 0, 'a/b': 1,
        options: [{ id: 'x', label: 'X', color: 'red' }],
        validation: { required: true, minLength: 2 },
        logic: { enabled: false, extra: 1 },
      }],
      settings: { ...V1.DEFAULT_SETTINGS, legacy: true },
    })) as unknown);
    if (!result.success) throw new Error(result.error);
    expect(result.repairs).toEqual([
      { path: '/theme', reason: 'unknown_key' },
      { path: '/blocks/0/a~1b', reason: 'unknown_key' },
      { path: '/blocks/0/options/0/color', reason: 'unknown_key' },
      { path: '/blocks/0/options/0/value', reason: 'defaulted' },
      { path: '/blocks/0/validation/minLength', reason: 'unknown_key' },
      { path: '/blocks/0/logic/extra', reason: 'unknown_key' },
      { path: '/settings/legacy', reason: 'unknown_key' },
    ]);
  });

  it('keeps customize whole except a __proto__ key', () => {
    const raw = JSON.parse('{"id":"f","title":"t","description":"","blocks":[{"id":"a","type":"text","label":"A","order":0,"customize":{"width":"half","__proto__":{"x":1}}}]}') as unknown;
    const result = parseV1(raw);
    if (!result.success) throw new Error(result.error);
    expect(result.data.blocks[0]?.customize).toStrictEqual({ width: 'half' });
    expect(result.repairs).toContainEqual({ path: '/blocks/0/customize/__proto__', reason: 'unknown_key' });
  });

  it('refuses non-forms and v2 documents', () => {
    expect(parseV1(null)).toMatchObject({ success: false });
    expect(parseV1({ title: 'x' })).toMatchObject({ success: false });
    expect(parseV1({ schemaVersion: 2, blocks: [] })).toMatchObject({ success: false });
  });
});
