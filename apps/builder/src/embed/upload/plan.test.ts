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
