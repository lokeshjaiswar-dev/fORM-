import { REGISTRY } from '@form/registry';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { compile, createEvaluator, evaluate } from '../src/index.ts';
import { META, all, any, ans, bid, choices, cond, disable, field, form, heading, hide, num, opts, page, requireIt, rule, show, text, versionOf } from './build.ts';
import { rng } from './corpus/generate.ts';
import { randomAnswer } from './corpus/random.ts';

/*
 * WP-0.07 targets: a 300-block / 200-rule form evaluates in < 5 ms p95 in Node, and an incremental
 * update in < 1 ms p95. This file runs on its own (`pnpm test:perf`: no coverage, one file at a time),
 * never inside the coverage-instrumented `pnpm test`. Each measurement runs several trials after a
 * warm-up and asserts on the best trial's p95, which a busy neighbour cannot inflate; every trial is printed.
 *
 * Nothing timed reuses an answer object, so every answer goes through its zod twin as a submission does.
 * The full-evaluation target is for a loaded version: evaluate() prepares the plan once per `compiled`
 * object, and the API and runtime keep loaded versions cached (architecture §2.5, §4.1). The cold case
 * (a freshly parsed version: definition, plan and answers all new) is measured and printed against the
 * same target and asserted only against the looser COLD_LIMIT.
 */

const TARGET = { full: 5, incremental: 1 };
const SLACK = Number(process.env.FORM_PERF_SLACK ?? '2') || 2;
/* A regression guard, not the target: the cold path pays plan preparation and a heap full of freshly parsed objects. */
const COLD_LIMIT = 4 * TARGET.full * SLACK;
const TRIALS = 5;
const now = () => performance.now();

function bigForm(): S.FormDefinition {
  const r = rng(300_200);
  const kinds = ['short_text', 'number', 'single_choice', 'multi_choice', 'date', 'rating', 'email', 'long_text', 'nps', 'heading'] as const;
  const blocks: S.StoredBlock[] = Array.from({ length: 300 }, (_, i) => {
    const kind = kinds[i % kinds.length] as (typeof kinds)[number];
    const blockId = `b${i}`;
    if (kind === 'heading') return heading(blockId);
    if (kind === 'single_choice') return field('single_choice', blockId, { config: { display: 'radio', options: choices('a', 'b', 'c') } });
    if (kind === 'multi_choice') return field('multi_choice', blockId, { config: { display: 'checkbox', options: choices('a', 'b', 'c') } });
    return field(kind, blockId) as S.FieldBlock;
  });
  const leaf = (source: S.StoredBlock): S.Condition => {
    switch (source.type) {
      case 'number':
      case 'rating':
      case 'nps':
        return cond(ans(source.id), r.pick(['gt', 'lte', 'eq'] as const), num(String(r.int(10))));
      case 'single_choice':
      case 'multi_choice':
        return cond(ans(source.id), 'includes_any', opts(source.id, 'a', 'c'));
      case 'date':
        return cond(ans(source.id), 'is_answered');
      default:
        return cond(ans(source.id), r.pick(['contains', 'eq', 'neq'] as const), text(r.pick(['yes', 'Delhi', 'x'])));
    }
  };
  const rules = Array.from({ length: 200 }, (_, i) => {
    const targetIndex = 100 + i;
    const sources = Array.from({ length: 2 + r.int(3) }, () => blocks[r.int(targetIndex)] as S.StoredBlock).filter((b) => b.type !== 'heading');
    const when = r.chance(0.5) ? all(...sources.map(leaf)) : any(all(...sources.slice(0, 2).map(leaf)), ...sources.slice(2).map(leaf));
    const target = blocks[targetIndex] as S.StoredBlock;
    const actions = target.type === 'heading' ? [show(target.id)] : [r.pick([show, hide, requireIt, disable])(target.id)];
    return rule(`r${i}`, when, actions, r.chance(0.3) ? [hide(target.id)] : undefined);
  });
  const pages = Array.from({ length: 10 }, (_, p) => page(`p${p}`, blocks.slice(p * 30, p * 30 + 30).map((b) => b.id)));
  return form(blocks, pages, rules);
}

const p95 = (samples: number[]) => [...samples].sort((x, y) => x - y)[Math.floor(samples.length * 0.95)] ?? Number.NaN;
const ms = (n: number) => `${n.toFixed(3)} ms`;

/** Times `run(setup(i))` for each iteration, with `setup` outside the timer; returns each trial's p95. */
function trials<T>(iterations: number, setup: (i: number) => T, run: (input: T) => void): number[] {
  for (let i = 0; i < Math.min(iterations, 200); i += 1) run(setup(i));
  return Array.from({ length: TRIALS }, () => p95(Array.from({ length: iterations }, (_, i) => {
    const input = setup(i);
    const start = now();
    run(input);
    return now() - start;
  })));
}

function report(name: string, target: number, limit: number, results: number[], annotate = true): number {
  const best = Math.min(...results);
  const verdict = best < target ? 'meets' : 'MISSES';
  const line = `${name}: best p95 ${ms(best)} ${verdict} target < ${target} ms (limit ${limit} ms); trials ${results.map(ms).join(', ')}`;
  console.info(`[perf] ${line}`);
  /* A miss within the limit passes; on GitHub Actions it becomes a job annotation so a slow drift is visible. */
  if (annotate && best >= target && process.env.GITHUB_ACTIONS === 'true') console.info(`::warning title=logic benchmark::${line}`);
  return best;
}

describe('performance (300 blocks, 200 rules)', () => {
  const def = bigForm();
  const version = versionOf(def);
  const versionJson = JSON.stringify(version);
  const r = rng(7);
  const blocks = Object.values(def.blocks).filter((b): b is S.StoredBlock => b !== undefined);
  const answerJson = Array.from({ length: 40 }, () => JSON.stringify(Object.fromEntries(blocks.flatMap((b) => {
    const v = randomAnswer(r, b);
    return v ? [[b.id, v]] : [];
  }))));
  const freshAnswers = (i: number) => JSON.parse(answerJson[i % answerJson.length] as string) as S.Answers;

  it('compiles the benchmark form', () => {
    expect(Object.keys(def.blocks)).toHaveLength(300);
    expect(def.logic.rules).toHaveLength(200);
    const start = now();
    expect(compile(def, REGISTRY).ok).toBe(true);
    console.info(`[perf] compile: ${ms(now() - start)}`);
  });

  it(`full evaluation of a loaded version on fresh answers < ${TARGET.full} ms p95`, () => {
    const results = trials(400, freshAnswers, (answers) => evaluate(version, answers, META, 'server'));
    expect(report('full evaluation (loaded version, fresh answers)', TARGET.full, TARGET.full * SLACK, results)).toBeLessThan(TARGET.full * SLACK);
  });

  it('cold evaluation of a freshly parsed version (measured; asserted only against COLD_LIMIT)', () => {
    const setup = (i: number) => ({ loaded: JSON.parse(versionJson) as S.FormVersion, answers: freshAnswers(i) });
    const results = trials(150, setup, ({ loaded, answers }) => evaluate(loaded, answers, META, 'server'));
    expect(report('cold evaluation (fresh version and answers)', TARGET.full, COLD_LIMIT, results, false)).toBeLessThan(COLD_LIMIT);
  });

  it(`incremental update < ${TARGET.incremental} ms p95`, () => {
    const session = createEvaluator(version, META, 'client');
    const sets = answerJson.map((_, i) => freshAnswers(i));
    let answers = freshAnswers(0);
    session.evaluate(answers);
    const fieldIds = blocks.filter((b) => b.type !== 'heading').map((b) => bid(b.id));
    /* Each change is a new answer object (as a keystroke makes one), so its twin is parsed inside the timer. */
    const setup = () => {
      const blockId = fieldIds[r.int(fieldIds.length)] as S.BlockId;
      const next = sets[r.int(sets.length)]?.[blockId];
      answers = { ...answers };
      if (next) answers[blockId] = JSON.parse(JSON.stringify(next)) as S.AnswerValue;
      else delete answers[blockId];
      return { answers, blockId };
    };
    const results = trials(1_000, setup, (change) => session.update(change.answers, [change.blockId]));
    expect(report('incremental update', TARGET.incremental, TARGET.incremental * SLACK, results)).toBeLessThan(TARGET.incremental * SLACK);
  });
});
