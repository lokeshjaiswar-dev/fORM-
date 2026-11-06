import type { InlineDoc } from '@form/schema';
import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

const emptyInline = (): InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** FLD-48. Collapsible group of blocks; children live on the section, not on the page. */
export const section = defineBlock({
  type: 'section',
  kind: 'container',
  palette: [entry('section', null, 'layout', PALETTE_LABELS['palette.section'], 'chevrons-up-down', ['section', 'collapse', 'group', 'accordion', 'heading group'], { collapsible: true })],
  defaultConfig: () => ({ title: emptyInline(), children: [], collapsible: true, initiallyCollapsed: false }),
  texts: (block) => (block.config.title ? [`block:${block.id}:title`] : []),
  content: () => ['/config/children', '/config/title'],
});
