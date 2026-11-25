import { describe, expect, it } from 'vitest';
import { fixtures, initPayload } from '../bridge/fixtures.ts';
import { buildModel, initialValues } from './model.ts';
import { planRender } from './plan.ts';

describe('planRender', () => {
  it('compiles the fixture init into one page with two titled sections', () => {
    const built = buildModel(initPayload());
    if (!built.ok) throw new Error(built.message);
    const values = initialValues(built.model, initPayload().values);
    const planned = planRender(built.model, values, {}, initPayload().values);
    if (!planned.ok) throw new Error(planned.message);
    const def = planned.plan.version.definition;
    expect(def.pages[0]!.children).toEqual(['fp_section_doctype', 'fp_section_master']);
    expect(fixtures.cases).toBeTruthy();
  });
});

describe('planRender: linked dropdowns', () => {
  const U = (n: number) => `c3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const dd = (n: number, name: string, options: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
    id: U(n), type: 'dropdown', name, value: name, label: name, required: false, placeholder: '', options: options.map(([a, b]) => ({ name: a, value: b })), ...extra,
  });
  const link = { linkedTo: U(1), optionParents: { Mumbai: ['Gold'], Delhi: ['Silver'] } };
  function plan(doctypeFields: unknown[], masterFields: unknown[]) {
    const init = initPayload();
    init.doctypeFields = doctypeFields as never;
    init.masterFields = masterFields as never;
    init.values = {};
    const built = buildModel(init);
    if (!built.ok) throw new Error(built.message);
    const planned = planRender(built.model, initialValues(built.model, init.values), {}, init.values);
    if (!planned.ok) throw new Error(planned.message);
    return planned.plan.version.definition;
  }
  const config = (def: ReturnType<typeof plan>, n: number) => (def.blocks[U(n) as never] as unknown as { config: { dependsOn?: string; options: Array<{ code?: string; parentOptionIds?: string[] }> } }).config;

  it('carries the link into the rendered definition (master fields)', () => {
    const def = plan([], [dd(1, 'Tier', [['Gold', 'Gold'], ['Silver', 'Silver']]), dd(2, 'City', [['Mumbai', 'Mumbai'], ['Delhi', 'Delhi']], link)]);
    expect(config(def, 2).dependsOn).toBe(U(1));
    expect(config(def, 2).options.map((o) => o.parentOptionIds?.length)).toEqual([1, 1]);
  });
  it('links a master dropdown to a document-type dropdown (merged plan)', () => {
    const def = plan([dd(1, 'Tier', [['Gold', 'Gold'], ['Silver', 'Silver']])], [dd(2, 'City', [['Mumbai', 'Mumbai'], ['Delhi', 'Delhi']], link)]);
    expect(config(def, 2).dependsOn).toBe(U(1));
  });
  it('a field with DMS parent_field_id (remote options) keeps its own cascade and gets no link', () => {
    const def = plan([], [dd(1, 'Tier', [['Gold', 'Gold']]), dd(2, 'City', [['Mumbai', 'Mumbai']], { ...link, parent_field_id: U(1) })]);
    expect(config(def, 2).dependsOn).toBeUndefined();
  });
});

