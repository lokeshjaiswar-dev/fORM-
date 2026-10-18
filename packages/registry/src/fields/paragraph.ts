import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

/** FLD-45. Rich text AST only (I5); links, images and alt text are checked by validateStructure. */
export const paragraph = defineBlock({
  type: 'paragraph',
  kind: 'content',
  palette: [entry('paragraph', null, 'layout', PALETTE_LABELS['palette.paragraph'], 'text', ['text', 'paragraph', 'description', 'body', 'note'])],
  defaultConfig: () => ({ content: { type: 'doc', content: [{ type: 'paragraph' }] } }),
  texts: (block) => [`block:${block.id}:content`],
  content: () => ['/config/content'],
});
