import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/index.ts';
import { META, versionOf } from './build.ts';
import { V1_FORMS, v1AnswerSets } from './corpus/generate.ts';
import { FIX_NAMES, toV2, toV2Answers, v1Visibility, type Fix } from './corpus/v1.ts';

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
    for (const fix of FIX_NAMES) expect(differences[fix], fix).toBeGreaterThan(0);
  });
});
