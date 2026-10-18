import { REGISTRY } from '@form/registry';
import type * as S from '@form/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile, createEvaluator, evalStateJson, evaluate } from '../src/index.ts';
import { META, versionOf } from './build.ts';
import { rng } from './corpus/generate.ts';
import { randomAnswers, randomForm } from './corpus/random.ts';

/* Compiling random forms once; fast-check then drives answers, metadata and change sequences. */
const versions = Array.from({ length: 60 }, (_, i) => randomForm(500 + i))
  .filter((def) => compile(def, REGISTRY).ok)
  .map((def) => versionOf(def));

const anyJson = fc.jsonValue({ maxDepth: 4 });
const blockIdOf = (version: S.FormVersion, i: number) => Object.keys(version.definition.blocks)[i % Object.keys(version.definition.blocks).length] as S.BlockId;

/** Arbitrary garbage where answers go: wrong types, wrong shapes, prototype keys, unknown blocks. */
const junkAnswers = (version: S.FormVersion) =>
  fc.array(fc.tuple(fc.nat(), fc.oneof(
    anyJson,
    fc.record({ type: fc.constantFrom('short_text', 'number', 'single_choice', 'multi_choice', 'date', 'rating', 'nps', 'hidden', 'nope'), value: anyJson }),
  ), fc.constantFrom('', '__proto__', 'constructor', 'ghost')), { maxLength: 12 })
    .map((entries) => {
      const out: Record<string, unknown> = {};
      for (const [i, value, special] of entries) Object.defineProperty(out, special || blockIdOf(version, i), { value, enumerable: true, configurable: true, writable: true });
      return out as S.Answers;
    });

const junkMeta = fc.record({
  urlParams: fc.dictionary(fc.constantFrom('src', 'utm_source', 'constructor', '__proto__', 'toString', 'k0'), fc.string(), { maxKeys: 4 }),
  device: fc.constantFrom(undefined, 'mobile', 'desktop'),
  isPreview: fc.boolean(),
});

describe('evaluate is total (fuzzing)', () => {
  it('compiles most random P0 forms', () => {
    expect(versions.length).toBeGreaterThan(40);
  });

  it('never throws on arbitrary answers and metadata, and keeps only valid, visible answers', () => {
    fc.assert(
      fc.property(fc.nat({ max: versions.length - 1 }).chain((v) => fc.tuple(fc.constant(versions[v] as S.FormVersion), junkAnswers(versions[v] as S.FormVersion), junkMeta)), ([version, answers, m]) => {
        const meta: S.EvalMeta = { ...META, urlParams: m.urlParams, isPreview: m.isPreview, ...(m.device ? { device: m.device as 'mobile' } : {}) };
        for (const scope of ['client', 'server'] as const) {
          const state = evaluate(version, answers, meta, scope, { trace: true });
          for (const [blockId, answer] of Object.entries(state.values)) {
            expect(state.visible.has(blockId as S.BlockId)).toBe(true);
            expect(version.definition.blocks[blockId as S.BlockId]?.type).toBe(answer?.type);
          }
          for (const p of state.path) expect(state.visible.has(p)).toBe(true);
          expect(() => evalStateJson(state, version.definition.pages.map((p) => p.id))).not.toThrow();
        }
      }),
      { numRuns: 400 },
    );
  });

  it('incremental updates equal a full pass after any sequence of changes', () => {
    fc.assert(
      fc.property(fc.nat({ max: versions.length - 1 }), fc.nat(), fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 25 }), (v, seed, steps) => {
        const version = versions[v] as S.FormVersion;
        const r = rng(seed);
        const pages = version.definition.pages.map((p) => p.id);
        const session = createEvaluator(version, META, 'client', { trace: true });
        let answers = randomAnswers(r, version.definition);
        session.evaluate(answers);
        for (const step of steps) {
          const blockId = blockIdOf(version, step);
          const next = randomAnswers(r, version.definition);
          const type = version.definition.blocks[blockId]?.type ?? 'short_text';
          answers = { ...answers };
          /* Every third change is an answer that fails its twin, so absent ↔ invalid transitions are covered. */
          if (step % 3 === 0) answers[blockId] = { type, value: { invalid: step } } as unknown as S.AnswerValue;
          else if (next[blockId]) answers[blockId] = next[blockId];
          else delete answers[blockId];
          const incremental = session.update(answers, [blockId]);
          expect(evalStateJson(incremental, pages)).toBe(evalStateJson(evaluate(version, answers, META, 'client', { trace: true }), pages));
        }
      }),
      { numRuns: 300 },
    );
  });
});
