import { describe, expect, it } from 'vitest';
import { fixtures, initPayload } from '../bridge/fixtures.ts';
import { buildModel, initialValues } from './model.ts';
import { planRender } from './plan.ts';

/* The lookups a form plan keeps: only into fields a person can edit (server-side lookups, F7). */

const A = (n: number) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const el = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ id: A(n), type: 'textinput', value: name, name, label: name, ...extra });

function plan(masterFields: unknown[], readOnly = false) {
  const init = initPayload();
  init.doctypeFields = [];
  init.masterFields = masterFields as never;
  init.values = {};
  init.readOnly = readOnly;
  const built = buildModel(init);
  if (!built.ok) throw new Error(built.message);
  const planned = planRender(built.model, initialValues(built.model, {}), {}, {});
  if (!planned.ok) throw new Error(planned.message);
  return planned.plan.version.definition.lookups ?? [];
}
const picker = fixtures.lookup.pickerElement as Record<string, unknown>;

describe('planRender: lookups', () => {
  it('keeps the lookup of the fixture and its mappings', () => {
    const lookups = plan([picker, el(2, 'City'), el(3, 'Phone'), el(4, 'Tax Id')]);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({ id: 'vendor', source: 'dms_master', masterId: 'm-vendors', minChars: 2 });
    expect(lookups[0]!.mappings.map((m) => m.fieldId)).toEqual([A(2), A(3), A(4)]);
  });

  it('never fills an auto-increment field, a legacy field or a field that is not in the form', () => {
    const lookups = plan([picker, el(2, 'City', { increment: true }), el(3, 'Phone', { legacy: { from: 'files', readOnly: true } }), el(4, 'Tax Id')]);
    expect(lookups[0]!.mappings.map((m) => m.fieldId)).toEqual([A(4)]);
  });

  it('a read-only form has no lookups', () => {
    expect(plan([picker, el(2, 'City'), el(3, 'Phone'), el(4, 'Tax Id')], true)).toEqual([]);
  });

  it('a locked search field drops its lookup', () => {
    expect(plan([{ ...picker, increment: true }, el(2, 'City'), el(3, 'Phone'), el(4, 'Tax Id')])).toEqual([]);
  });
});
