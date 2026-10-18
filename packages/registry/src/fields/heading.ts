import type { InlineDoc } from '@form/schema';
import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

const emptyInline = (): InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const keywords = ['heading', 'title', 'header', 'section'];

/** FLD-44: one type with a level (v1 heading / heading_2 / heading_3). */
export const heading = defineBlock({
  type: 'heading',
  kind: 'content',
  palette: [
    entry('heading', '1', 'layout', PALETTE_LABELS['palette.heading.1'], 'heading-1', [...keywords, 'h1'], { level: 1 }),
    entry('heading', '2', 'layout', PALETTE_LABELS['palette.heading.2'], 'heading-2', [...keywords, 'h2'], { level: 2 }),
    entry('heading', '3', 'layout', PALETTE_LABELS['palette.heading.3'], 'heading-3', [...keywords, 'h3'], { level: 3 }),
  ],
  defaultConfig: () => ({ level: 2, text: emptyInline() }),
  texts: (block) => [`block:${block.id}:text`, ...(block.config.subheading ? [`block:${block.id}:subheading` as const] : [])],
  content: (block) => (block.config.subheading ? ['/config/text', '/config/subheading'] : ['/config/text']),
});
