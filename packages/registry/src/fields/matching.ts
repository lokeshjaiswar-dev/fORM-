import type { MatchingPromptId, OptionId } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, defaultOptions, entry, hasOption, isRootPath, optionAltLint, optionLabel, optionList, optionTexts, pairLines } from './shared.ts';

/** Pair each prompt with one option; exclusive matching forbids reusing an option. */
export const matching = defineField({
  type: 'matching',
  palette: [entry('matching', null, 'choice', PALETTE_LABELS['palette.matching'], 'git-compare', ['matching', 'pair', 'match', 'connect', 'link items'])],
  defaultConfig: (locale) => ({
    prompts: [1, 2, 3].map((n) => ({ id: `prompt_${n}` as MatchingPromptId, label: message(locale, DEFAULT_TEXT['defaults.matching_prompt'], { n }) })),
    options: defaultOptions(locale),
    exclusive: true,
  }),
  checkConfig: (config, report) => {
    const seen = new Set<string>();
    config.prompts.forEach((prompt, i) => {
      if (seen.has(prompt.id)) report('prompt ids must be unique', ['prompts', i, 'id']);
      seen.add(prompt.id);
    });
    if (config.exclusive && config.options.length < config.prompts.length) {
      report('exclusive matching needs at least as many options as prompts', ['options']);
    }
  },
  checkAnswer: (value, block, state, report) => {
    const used = new Set<OptionId>();
    const promptIds = new Set(block.config.prompts.map((p) => p.id));
    for (const [promptId, optionId] of Object.entries(value) as Array<[MatchingPromptId, OptionId | undefined]>) {
      if (optionId === undefined) continue;
      if (!promptIds.has(promptId)) report('not_in_options', [promptId]);
      if (!hasOption(block.config.options, optionId)) report('not_in_options', [promptId]);
      else if (block.config.exclusive && used.has(optionId)) report('invalid_format', [promptId]);
      used.add(optionId);
    }
    if (state.required && block.config.prompts.some((p) => value[p.id] === undefined)) report('too_few_selected');
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? optionList(Object.values(value).filter((id): id is OptionId => id !== undefined)) : NULL),
  isEmpty: (value) => Object.values(value).every((id) => id === undefined),
  columns: (block) => block.config.prompts.map((prompt) => ({ suffix: `.${prompt.id}`, header: `${headerOf(block)} ${prompt.label}` })),
  cells: (value, block) => block.config.prompts.map((prompt) => {
    const id = value[prompt.id];
    return id === undefined ? '' : optionLabel(block.config.options, id);
  }),
  text: (value, block) => pairLines(block.config.prompts.map((prompt) => {
    const id = value[prompt.id];
    return [prompt.label, id === undefined ? '' : optionLabel(block.config.options, id)] as const;
  })),
  texts: (block) => [
    ...optionTexts(block.id, block.config.options),
    ...block.config.prompts.map((p) => `mrow:${block.id}/${p.id}` as const),
  ],
  content: () => ['/config/prompts', '/config/options'],
  lint: (block) => optionAltLint(block.id, block.config.options),
});
