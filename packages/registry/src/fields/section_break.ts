import { configTexts, defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

/** Named section marker: starts a named step in the section navigator. */
export const sectionBreak = defineBlock({
  type: 'section_break',
  kind: 'content',
  palette: [entry('section_break', null, 'layout', PALETTE_LABELS['palette.section_break'], 'list-ordered', ['section', 'break', 'step', 'progress', 'wizard'])],
  defaultConfig: () => ({ name: 'Section', showInNav: true, showHeading: false, marker: 'card' }),
  texts: (block) => configTexts(block, ['name', 'description']),
  content: () => ['/config/name'],
});
