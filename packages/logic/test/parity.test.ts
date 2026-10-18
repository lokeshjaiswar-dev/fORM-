import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import { migrateV1ToV2, parseV1, toDecimal } from '@form/schema';
import type * as S from '@form/schema';
import { V1_FIXTURES, migrationContext } from '@form/schema/migration-fixtures';
import { evaluate } from '../src/index.ts';
import { META, versionOf } from './build.ts';
import { V1_FORMS, rng, v1AnswerSets } from './corpus/generate.ts';
import { FIX_NAMES, toV2, toV2Answers, v1Visibility, type Fix, type OracleBlock, type V1Values } from './corpus/v1.ts';

const ANSWER_SETS = 200;
const ALL_FIXES: ReadonlySet<Fix> = new Set(FIX_NAMES);
const NO_FIXES: ReadonlySet<Fix> = new Set();

describe(`v1 show/hide parity (${V1_FORMS.length} fixtures × ${ANSWER_SETS} answer sets)`, () => {
  const differences = Object.fromEntries(FIX_NAMES.map((f) => [f, 0])) as Record<Fix, number>;

  it.each(V1_FORMS.map((f, i) => ({ name: f.name, f, i })))('$name', ({ f, i }) => {
    const version = versionOf(toV2(f));
    const mismatches: string[] = [];
    v1AnswerSets(f, ANSWER_SETS, 7_000 + i).forEach((values, n) => {
      const expected = v1Visibility(f, values, ALL_FIXES);
      const raw = v1Visibility(f, values, NO_FIXES);
      const state = evaluate(version, toV2Answers(f, values), META, 'client');
      for (const b of f.blocks) {
        if (state.visible.has(b.id as never) !== expected.get(b.id)) mismatches.push(`set ${n}, ${b.id}: v2 ${state.visible.has(b.id as never)}, v1 ${expected.get(b.id)} (${JSON.stringify(values)})`);
        if (raw.get(b.id) === expected.get(b.id)) continue;
        for (const fix of FIX_NAMES) if (v1Visibility(f, values, new Set([fix])).get(b.id) !== raw.get(b.id)) differences[fix] += 1;
      }
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('every difference from v1 is a documented fix, and each fix is exercised', () => {
    for (const fix of FIX_NAMES) if (fix !== 'numeric_equality') expect(differences[fix], fix).toBeGreaterThan(0);
  });
});

/*
 * BL-074: the same oracle over the migrate() output of the WP-0.05 corpus (5 templates + 30 bug fixtures). Besides
 * the oracle's fixes, migration turns off rules v2 cannot keep; MIGRATION_FIXES names them (the oracle reads that
 * block's logic as off), and the value b15 matches by label (schema §4.2: by value, then by label).
 */
const MIGRATION_FIXES: Readonly<Record<string, { off?: readonly string[]; value?: Readonly<Record<string, string>> }>> = {
  'b01-paging-later-page': { off: ['b01_promo'] }, // reads a later page (I8)
  'b15-option-values': { value: { b15_seats: 'team' } }, // 'Team' is the label of the option whose value is 'team'
  'b20-duplicated-blocks': { off: ['b20_loop_b', 'b20_self'] }, // logic cycles, broken at their last block
  'b21-dangling-logic': { off: ['b21_from_heading'] }, // reads a heading, which has no answer
  'b28-rating-max': { off: ['b28_beyond', 'b28_negative'] }, // never true on the clamped rating or the shifted scale
};

const POOLS = {
  text: ['yes', '  yes ', 'Yes', 'no', 'hello', 'acme', 'free stuff', 'VIP', 'newsletter', 'x', '', 'Delhi'],
  email: ['asha@example.in', 'ravi@acme.com', 'x@y.org'],
  url: ['https://example.com/acme', 'http://x.org'],
  number: ['0', '2', '5', '6', '18', '19', '-1', '3.5', '100', '0.0', '05', '18.0'],
  date: ['2026-01-01', '2026-11-30', '2026-12-01', '2027-05-13'],
  time: ['09:00', '17:59', '18:00', '18:30'],
};

interface Migrated { name: string; blocks: S.V1.FormBlock[]; oracle: OracleBlock[]; ids: Map<string, S.BlockId>; def: S.FormDefinition }

function migrated(name: string, doc: unknown): Migrated {
  const form = parseV1(doc);
  if (!form.success) throw new Error(`${name}: ${form.error}`);
  const def = migrateV1ToV2(form.data, migrationContext(REGISTRY)).definition;
  const blocks = form.data.blocks.map((b, i) => ({ b, i })).sort((x, y) => x.b.order - y.b.order || x.i - y.i).map((x) => x.b)
    .filter((b) => b.type !== 'page_break' && b.type !== 'thank_you');
  const placed = def.pages.flatMap((p) => p.children);
  if (placed.length !== blocks.length) throw new Error(`${name}: ${placed.length} placed blocks for ${blocks.length} v1 blocks`);
  const fixes = MIGRATION_FIXES[name] ?? {};
  const oracle = blocks.map((b): OracleBlock => {
    const value = fixes.value?.[b.id];
    const logic = b.logic && !fixes.off?.includes(b.id) ? (value === undefined ? b.logic : { ...b.logic, value }) : undefined;
    return { id: b.id, type: b.type, ...(b.options ? { options: b.options } : {}), ...(logic ? { logic } : {}) };
  });
  return { name, blocks, oracle, ids: new Map(blocks.map((b, i) => [b.id, placed[i] as S.BlockId])), def };
}

/** Seeded v1 values and the same answers in v2; phone, ranking, file, signature and hidden fields stay unanswered. */
function answerSets(m: Migrated, count: number, seed: number): Array<{ v1: V1Values; v2: S.Answers }> {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const v1: V1Values = {};
    const v2: Partial<Record<S.BlockId, S.AnswerValue>> = {};
    for (const b of m.blocks) {
      const id = m.ids.get(b.id) as S.BlockId;
      const block = m.def.blocks[id];
      if (!block || !('compliance' in block) || r.chance(0.25)) continue;
      switch (block.type) {
        case 'short_text':
        case 'long_text':
        case 'url': {
          const value = r.pick(block.type === 'url' ? POOLS.url : POOLS.text);
          v1[b.id] = value;
          if (value.trim()) v2[id] = { type: block.type, value: value.trim() };
          break;
        }
        case 'email':
          v1[b.id] = r.pick(POOLS.email);
          v2[id] = { type: 'email', value: { address: v1[b.id] as S.EmailAddress } };
          break;
        case 'number':
          v1[b.id] = r.pick(POOLS.number);
          v2[id] = { type: 'number', value: toDecimal(v1[b.id] as string) as S.DecimalString };
          break;
        case 'rating':
        case 'nps':
        case 'linear_scale': {
          const [lo, hi] = block.type === 'rating' ? [1, block.config.max] : block.type === 'nps' ? [0, 10] : [block.config.min, block.config.max];
          const value = lo + r.int(hi - lo + 1);
          v1[b.id] = value;
          v2[id] = { type: block.type, value };
          break;
        }
        case 'single_choice': {
          const i = r.int(block.config.options.length);
          v1[b.id] = b.options?.[i]?.value;
          v2[id] = { type: 'single_choice', value: { optionId: block.config.options[i]?.id ?? null } };
          break;
        }
        case 'multi_choice': {
          const picked = block.config.options.map((_, i) => i).filter(() => r.chance(0.4));
          v1[b.id] = picked.map((i) => b.options?.[i]?.value);
          if (picked.length) v2[id] = { type: 'multi_choice', value: { optionIds: picked.map((i) => block.config.options[i]?.id as S.OptionId) } };
          break;
        }
        case 'date':
          v1[b.id] = r.pick(POOLS.date);
          v2[id] = { type: 'date', value: v1[b.id] as S.IsoDate };
          break;
        case 'time':
          v1[b.id] = r.pick(POOLS.time);
          v2[id] = { type: 'time', value: { start: v1[b.id] as S.IsoTime } };
          break;
        default:
          break;
      }
    }
    return { v1, v2: v2 as S.Answers };
  });
}

describe(`v1 show/hide parity on the migrated WP-0.05 corpus (${V1_FIXTURES.length} forms × ${ANSWER_SETS} answer sets)`, () => {
  const corpus = V1_FIXTURES.map(({ name, doc }) => migrated(name, doc));
  const seen = new Set<string>();
  let numericEquality = 0;

  it.each(corpus.map((m, i) => ({ name: m.name, m, i })))('$name', ({ m, i }) => {
    /* Migration turns off exactly the rules the oracle's fixes and MIGRATION_FIXES expect. */
    const byId = new Map(m.blocks.map((b) => [b.id, b]));
    const live = new Set(m.def.logic.rules.filter((r) => r.enabled).flatMap((r) => r.then.flatMap((a) => (a.type === 'show' || a.type === 'hide' ? a.targets : []))));
    const unmatched = (b: S.V1.FormBlock) => {
      const source = byId.get(b.logic?.sourceBlockId ?? '');
      const value = MIGRATION_FIXES[m.name]?.value?.[b.id] ?? b.logic?.value;
      return source?.options !== undefined && ['equals', 'not_equals', undefined].includes(b.logic?.operator) && value !== undefined && !source.options.some((o) => o.value === value);
    };
    const withLogic = m.blocks.filter((b) => b.logic?.enabled && b.logic.sourceBlockId);
    const expectedOff = withLogic.filter((b) => MIGRATION_FIXES[m.name]?.off?.includes(b.id) || !byId.has(b.logic?.sourceBlockId ?? '') || unmatched(b)).map((b) => b.id);
    expect(withLogic.filter((b) => !live.has(m.ids.get(b.id) as S.BlockId)).map((b) => b.id)).toEqual(expectedOff);

    const version = versionOf(m.def);
    const mismatches: string[] = [];
    answerSets(m, ANSWER_SETS, 9_000 + i).forEach(({ v1, v2 }, n) => {
      const expected = v1Visibility({ blocks: m.oracle }, v1, ALL_FIXES);
      const withoutNumeric = v1Visibility({ blocks: m.oracle }, v1, new Set(FIX_NAMES.filter((f) => f !== 'numeric_equality')));
      numericEquality += m.oracle.filter((b) => expected.get(b.id) !== withoutNumeric.get(b.id)).length;
      const state = evaluate(version, v2, META, 'client');
      for (const b of m.oracle) {
        const visible = state.visible.has(m.ids.get(b.id) as S.BlockId);
        if (visible !== expected.get(b.id)) mismatches.push(`set ${n}, ${b.id}: v2 ${visible}, v1 ${expected.get(b.id)} (${JSON.stringify(v1)})`);
        seen.add(`${m.name}/${b.id}/${visible}`);
      }
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('exercises numeric_equality: a number answer such as 0.0 equals the v1 value 0', () => {
    expect(numericEquality).toBeGreaterThan(0);
  });

  it('exercises the live rules: their targets are both shown and hidden', () => {
    const targets = corpus.flatMap((m) => m.blocks.filter((b) => m.def.logic.rules.some((r) => r.enabled && r.then.some((a) => (a.type === 'show' || a.type === 'hide') && a.targets.includes(m.ids.get(b.id) as S.BlockId)))).map((b) => `${m.name}/${b.id}`));
    const once = targets.filter((t) => !(seen.has(`${t}/true`) && seen.has(`${t}/false`)));
    expect(targets.length).toBeGreaterThanOrEqual(30);
    /* v1 never captured hidden fields (B26), so a rule reading one has a constant result there. */
    expect(once).toEqual(['b26-hidden-fields/b26_promo']);
  });
});
