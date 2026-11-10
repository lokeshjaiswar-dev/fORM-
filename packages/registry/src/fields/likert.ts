import type { LikertStatementId } from '@form/schema';
import { configTexts, defineField, headerOf, isBlank } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** One integer on a shared scale for each statement. */
export const likert = defineField({
  type: 'likert',
  palette: [entry('likert', null, 'rating', PALETTE_LABELS['palette.likert'], 'rows-3', ['likert', 'agree', 'scale', 'survey', 'statements'])],
  defaultConfig: (locale) => ({
    statements: [1, 2, 3].map((n) => ({ id: `stmt_${n}` as LikertStatementId, label: message(locale, DEFAULT_TEXT['defaults.likert_statement'], { n }) })),
    min: 1 as const,
    max: 5,
  }),
  checkConfig: (config, report) => {
    const seen = new Set<string>();
    config.statements.forEach((stmt, i) => {
      if (seen.has(stmt.id)) report('statement ids must be unique', ['statements', i, 'id']);
      seen.add(stmt.id);
    });
    if (config.max < 2) report('max must be at least 2', ['max']);
  },
  checkAnswer: (value, block, state, report) => {
    const known = new Set(block.config.statements.map((s) => s.id));
    for (const [id, score] of Object.entries(value) as Array<[LikertStatementId, number | undefined]>) {
      if (score === undefined) continue;
      if (!known.has(id)) report('not_in_options', [id]);
      if (score < block.config.min) report('below_min', [id]);
      if (score > block.config.max) report('above_max', [id]);
    }
    if (state.required && block.config.statements.some((s) => value[s.id] === undefined)) report('too_few_selected');
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
  columns: (block) => block.config.statements.map((stmt) => ({ suffix: `.${stmt.id}`, header: `${headerOf(block)} ${stmt.label}` })),
  cells: (value, block) => block.config.statements.map((stmt) => (value[stmt.id] === undefined ? '' : String(value[stmt.id]))),
  texts: (block) => [
    ...configTexts(block, ['lowLabel', 'highLabel']),
    ...block.config.statements.map((s) => `mrow:${block.id}/${s.id}` as const),
  ],
  content: () => ['/config/statements'],
});
