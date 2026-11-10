import type { SemanticPairId } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** Bipolar adjective pairs scored on a shared integer scale. */
export const semanticDifferential = defineField({
  type: 'semantic_differential',
  palette: [entry('semantic_differential', null, 'rating', PALETTE_LABELS['palette.semantic_differential'], 'arrow-left-right', ['semantic differential', 'bipolar', 'adjective', 'osgood'])],
  defaultConfig: (locale) => ({
    pairs: [1, 2, 3].map((n) => ({
      id: `pair_${n}` as SemanticPairId,
      left: message(locale, DEFAULT_TEXT['defaults.semantic_left'], { n }),
      right: message(locale, DEFAULT_TEXT['defaults.semantic_right'], { n }),
    })),
    min: 1 as const,
    max: 7,
  }),
  checkConfig: (config, report) => {
    const seen = new Set<string>();
    config.pairs.forEach((pair, i) => {
      if (seen.has(pair.id)) report('pair ids must be unique', ['pairs', i, 'id']);
      seen.add(pair.id);
    });
  },
  checkAnswer: (value, block, state, report) => {
    const known = new Set(block.config.pairs.map((p) => p.id));
    for (const [id, score] of Object.entries(value) as Array<[SemanticPairId, number | undefined]>) {
      if (score === undefined) continue;
      if (!known.has(id)) report('not_in_options', [id]);
      if (score < block.config.min) report('below_min', [id]);
      if (score > block.config.max) report('above_max', [id]);
    }
    if (state.required && block.config.pairs.some((p) => value[p.id] === undefined)) report('too_few_selected');
  },
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => {
    if (!isRootPath(path)) return NULL;
    const scores = Object.values(value).filter((n): n is number => typeof n === 'number');
    if (scores.length === 0) return NULL;
    return countScalar(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
  },
  isEmpty: (value) => Object.values(value).every(isBlank),
  columns: (block) => block.config.pairs.map((pair) => ({ suffix: `.${pair.id}`, header: `${headerOf(block)} ${pair.left}–${pair.right}` })),
  cells: (value, block) => block.config.pairs.map((pair) => (value[pair.id] === undefined ? '' : String(value[pair.id]))),
  texts: (block) => block.config.pairs.map((p) => `mrow:${block.id}/${p.id}` as const),
  content: () => ['/config/pairs'],
});
