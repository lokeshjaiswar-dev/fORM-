import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

/** FLD-47. */
export const divider = defineBlock({
  type: 'divider',
  kind: 'content',
  palette: [entry('divider', null, 'layout', PALETTE_LABELS['palette.divider'], 'minus', ['divider', 'line', 'separator', 'rule', 'hr'])],
  defaultConfig: () => ({ lineStyle: 'solid', spacing: 'md' }),
  texts: () => [],
  content: () => [],
});
