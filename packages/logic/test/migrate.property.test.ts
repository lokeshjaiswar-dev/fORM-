import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import { V1, V1MigrationResultSchema, migrateUnknown, migrateV1ToV2, parseV1 } from '@form/schema';
import type { PublishIssue } from '@form/schema';
import { V1_FIXTURES, migrationContext } from '@form/schema/migration-fixtures';
import { compile, validateDefinition } from '../src/index.ts';

/*
 * Schema §4.3 P0-a property test: corpus forms with random logic wiring, operators, values, order, required/disabled,
 * patterns, messages, defaults and limits still migrate to output that parses, passes validateDefinition(…, 'save'),
 * compiles, and that migrate() leaves unchanged.
 */

type Raw = { blocks: Array<Record<string, unknown>>; settings: Record<string, unknown> } & Record<string, unknown>;

const VALUES = ['', 'yes', 'Yes', '0', '05', '5.0', ' 05.50 ', '-1', '18', 'abc', '2026-02-30', '2026-11-01', '09:30', '25:00', 'x'.repeat(250)];
const PATTERNS = ['^[A-Z]{3}$', '(a+)+$', '[', '\\d+', ''];
const DEFAULTS = ['', 'a', '2', '2.5', '11', '2026-11-01', 'not a date', '09:30', 'WELCOME10'];
/* Ids shaped like the seeded idFactory output (m_1, m_2, …), so kept v1 ids and generated ones can collide. */
const OPTION_IDS = ['m_1', 'm_3', 'm_4', 'm_5', 'm_6', 'm_7', 'm_9', 'm_12', 'bad id', 'o_same'];
const FONTS = ['Inter', 'Georgia', 'Mono', 'constructor', 'toString', 'Comic Sans'];
const ALLOWED_WARNINGS: ReadonlySet<PublishIssue['code']> = new Set(['dangling_ref']);

const mutation = fc.record({
  form: fc.nat({ max: V1_FIXTURES.length - 1 }),
  font: fc.constantFrom(...FONTS),
  blocks: fc.array(fc.record({
    order: fc.integer({ min: -3, max: 40 }),
    logic: fc.option(fc.record({
      enabled: fc.constantFrom(true, true, true, false),
      action: fc.constantFrom('show', 'hide'),
      source: fc.oneof(fc.nat({ max: 40 }), fc.constantFrom('deleted', 'no such block!')),
      operator: fc.constantFrom(...V1.LOGIC_OPERATORS),
      value: fc.oneof(fc.constantFrom(...VALUES), fc.string({ maxLength: 8 })),
    }), { nil: undefined }),
    required: fc.boolean(),
    disabled: fc.boolean(),
    pattern: fc.option(fc.constantFrom(...PATTERNS), { nil: undefined }),
    errorMessage: fc.option(fc.constantFrom('Check this', ''), { nil: undefined }),
    defaultValue: fc.option(fc.constantFrom(...DEFAULTS), { nil: undefined }),
    min: fc.option(fc.integer({ min: -5, max: 20 }), { nil: undefined }),
    max: fc.option(fc.integer({ min: -5, max: 20 }), { nil: undefined }),
    optionIds: fc.option(fc.array(fc.constantFrom(...OPTION_IDS), { maxLength: 6 }), { nil: undefined }),
    range: fc.option(fc.record({ low: fc.integer({ min: -8, max: 4 }), high: fc.integer({ min: -2, max: 30 }) }), { nil: undefined }),
  }), { minLength: 12, maxLength: 40 }),
});

type Mutation = typeof mutation extends fc.Arbitrary<infer T> ? T : never;

function mutate(m: Mutation): unknown {
  const raw = JSON.parse(JSON.stringify(V1_FIXTURES[m.form]?.doc)) as Raw;
  raw.settings = { ...raw.settings, font: m.font };
  const ids = raw.blocks.map((b) => b['id'] as string);
  raw.blocks.forEach((block, i) => {
    const change = m.blocks[i];
    if (!change) return;
    block['order'] = change.order;
    const { logic } = change;
    if (logic) {
      const sourceBlockId = typeof logic.source === 'number' ? (ids[logic.source % ids.length] as string) : logic.source;
      block['logic'] = { enabled: logic.enabled, action: logic.action, sourceBlockId, operator: logic.operator, value: logic.value };
    }
    const validation: Record<string, unknown> = { ...(block['validation'] as object | undefined), required: change.required };
    if (change.pattern !== undefined) validation['pattern'] = change.pattern;
    if (change.errorMessage !== undefined) validation['errorMessage'] = change.errorMessage;
    if (change.min !== undefined) validation['min'] = change.min;
    if (change.max !== undefined) validation['max'] = change.max;
    block['validation'] = validation;
    const customize: Record<string, unknown> = { ...(block['customize'] as object | undefined), disabled: change.disabled };
    if (change.defaultValue !== undefined) customize['defaultValue'] = change.defaultValue;
    if (change.range) Object.assign(customize, { ratingMax: change.range.high, scaleMin: change.range.low, scaleMax: change.range.high });
    block['customize'] = customize;
    const options = block['options'] as Array<Record<string, unknown>> | undefined;
    change.optionIds?.forEach((id, o) => {
      if (options?.[o]) options[o]['id'] = id;
    });
  });
  return raw;
}

describe('v1 → v2 migration over mutated corpus forms (property)', () => {
  it('always parses, validates for save, compiles, is idempotent and depends on the idFactory only for ids', () => {
    let live = 0;
    let off = 0;
    let renamed = 0;
    let lookalike = 0;
    fc.assert(fc.property(mutation, (m) => {
      const parsed = parseV1(mutate(m));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const result = migrateV1ToV2(parsed.data, migrationContext(REGISTRY));
      const checked = V1MigrationResultSchema.safeParse(JSON.parse(JSON.stringify(result)));
      expect(checked.success ? [] : checked.error.issues).toEqual([]);
      const issues = validateDefinition(result.definition, 'save', REGISTRY);
      expect(issues.filter((i) => i.severity === 'error' || !ALLOWED_WARNINGS.has(i.code))).toEqual([]);
      const compiled = compile(result.definition, REGISTRY);
      expect(compiled.ok ? [] : compiled.issues).toEqual([]);
      for (const rule of result.definition.logic.rules) if (rule.enabled) live += 1; else off += 1;
      const again = migrateUnknown(JSON.parse(JSON.stringify(result.definition)), migrationContext(REGISTRY, 'again'));
      expect(again).toEqual({ definition: result.definition, notes: [] });
      /* Another idFactory changes the generated ids and nothing else (unless kept v1 ids look like generated ones). */
      if (!/\b[mq]_\d+\b/.test(JSON.stringify(parsed.data))) {
        const other = JSON.stringify(migrateV1ToV2(parsed.data, migrationContext(REGISTRY, 'q')).definition).replace(/\bq_(\d+)\b/g, 'm_$1');
        expect(JSON.parse(other)).toEqual(result.definition);
        renamed += 1;
      } else {
        lookalike += 1;
      }
    }), { seed: 20261018, numRuns: 500 });
    /* The runs exercise both kept and disabled rules. */
    expect(live).toBeGreaterThan(180);
    expect(off).toBeGreaterThan(450);
    expect(renamed).toBeGreaterThan(50);
    expect(lookalike).toBeGreaterThan(50);
  });
});
