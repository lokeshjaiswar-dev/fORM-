import type { InlineDoc } from '@form/schema';
import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

const emptyInline = (): InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const keywords = ['heading', 'title', 'header', 'section'];

/** FLD-44: one heading type; size is Small / Medium / Large (`level` 3 / 2 / 1). */
export const heading = defineBlock({
  type: 'heading',
  kind: 'content',
  palette: [entry('heading', null, 'layout', PALETTE_LABELS['palette.heading'], 'heading-1', [...keywords, 'h1', 'h2', 'h3'], { level: 1 })],
  defaultConfig: () => ({ level: 1, text: emptyInline() }),
  texts: (block) => [`block:${block.id}:text`, ...(block.config.subheading ? [`block:${block.id}:subheading` as const] : [])],
  content: (block) => (block.config.subheading ? ['/config/text', '/config/subheading'] : ['/config/text']),
});
