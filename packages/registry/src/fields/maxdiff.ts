import { defineField, headerOf } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, defaultOptions, entry, hasOption, isRootPath, optionAltLint, optionLabel, optionList, optionTexts } from './shared.ts';

/** MaxDiff: one best and one worst option; they must differ. */
export const maxdiff = defineField({
  type: 'maxdiff',
  palette: [entry('maxdiff', null, 'rating', PALETTE_LABELS['palette.maxdiff'], 'scale', ['maxdiff', 'best worst', 'most least', 'trade-off'])],
  defaultConfig: (locale) => ({ options: defaultOptions(locale) }),
  checkConfig: (config, report) => {
    if (config.options.length < 3) report('MaxDiff needs at least three options', ['options']);
  },
  checkAnswer: (value, block, _state, report) => {
    if (!hasOption(block.config.options, value.best)) report('not_in_options', ['best']);
    if (!hasOption(block.config.options, value.worst)) report('not_in_options', ['worst']);
    if (value.best === value.worst) report('invalid_format', ['worst']);
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? optionList([value.best, value.worst]) : NULL),
  isEmpty: (value) => !value.best || !value.worst,
  columns: (block) => {
    const header = headerOf(block);
    return [{ suffix: '.best', header: `${header} best` }, { suffix: '.worst', header: `${header} worst` }];
  },
  cells: (value, block) => [optionLabel(block.config.options, value.best), optionLabel(block.config.options, value.worst)],
  texts: (block) => optionTexts(block.id, block.config.options),
  content: () => ['/config/options'],
  lint: (block) => optionAltLint(block.id, block.config.options),
});
