import { createEvaluator, type Evaluator } from '@form/logic';
import type { AnswerValue, Answers, BlockId, EvalMeta, EvalState, RuntimeFormVersion } from '@form/schema';
import { normalizeAnswer, type RawAnswers } from '@form/validation/lazy';

/** The evaluation of the current answers: `answers` normalised (I9), `state` from logic@2. */
export interface Evaluation {
  answers: Answers;
  state: EvalState;
}

const same = (a: AnswerValue | undefined, b: AnswerValue | undefined) => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/**
 * Incremental client evaluation (FND-13): the evaluator keeps the session's frozen `meta`; each change of the
 * answers re-runs only the plan steps that read the blocks whose answers changed (`compiled.reads`). Unchanged
 * answers keep their object identity, which the evaluator's caches key on.
 */
export class EvalSession {
  private readonly evaluator: Evaluator;
  private current: Evaluation | null = null;

  constructor(version: RuntimeFormVersion, meta: EvalMeta) {
    this.evaluator = createEvaluator(version, meta, 'client');
  }

  evaluate(raw: RawAnswers): Evaluation {
    const previous = this.current?.answers ?? {};
    const answers: Record<string, AnswerValue> = {};
    const changed = new Set<BlockId>();
    for (const [id, value] of Object.entries(raw)) {
      const next = normalizeAnswer(value);
      const before = previous[id as BlockId];
      if (next === undefined) {
        if (before !== undefined) changed.add(id as BlockId);
        continue;
      }
      if (same(before, next)) answers[id] = before as AnswerValue;
      else {
        answers[id] = next;
        changed.add(id as BlockId);
      }
    }
    for (const id of Object.keys(previous)) if (!Object.hasOwn(answers, id)) changed.add(id as BlockId);
    if (this.current && changed.size === 0) return this.current;
    const state = this.current ? this.evaluator.update(answers as Answers, changed) : this.evaluator.evaluate(answers as Answers);
    this.current = { answers: answers as Answers, state };
    return this.current;
  }
}
