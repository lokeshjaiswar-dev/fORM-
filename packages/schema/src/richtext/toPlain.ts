import type { InlineDoc, InlineNode, ListItemNode, PipeAttrs, RichBlockNode, RichDoc, VarNode } from '../v2/rich-text.ts';
import { fromHtml } from './fromHtml.ts';

export interface PlainTextOptions {
  /** Value for a pipe; defaults to its fallback. */
  pipe?: (attrs: PipeAttrs) => string;
  /** Value for a template variable; defaults to its fallback, then `{name}`. */
  var?: (attrs: VarNode['attrs']) => string;
}

function inline(nodes: readonly InlineNode[] | undefined, options: PlainTextOptions): string {
  let out = '';
  for (const node of nodes ?? []) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'hardBreak') out += '\n';
    else if (node.type === 'pipe') out += options.pipe?.(node.attrs) ?? node.attrs.fallback ?? '';
    else out += options.var?.(node.attrs) ?? node.attrs.fallback ?? `{${node.attrs.name}}`;
  }
  return out;
}

const indent = (text: string, prefix: string, rest: string) => text.split('\n').map((line, i) => (i ? rest : prefix) + line).join('\n');

function item(node: ListItemNode, prefix: string, options: PlainTextOptions): string {
  const text = node.content.map((child) => block(child, options)).join('\n');
  return indent(text, prefix, ' '.repeat(prefix.length));
}

function block(node: RichBlockNode, options: PlainTextOptions): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inline(node.content, options);
    case 'bulletList':
      return node.content.map((child) => item(child, '- ', options)).join('\n');
    case 'orderedList': {
      const start = node.attrs?.start ?? 1;
      return node.content.map((child, i) => item(child, `${start + i}. `, options)).join('\n');
    }
    case 'blockquote':
      return indent(node.content.map((child) => block(child, options)).join('\n'), '> ', '> ');
    case 'horizontalRule':
      return '---';
    case 'image':
      return 'alt' in node.attrs.asset ? node.attrs.asset.alt ?? '' : '';
  }
}

/** Plain text for search, exports, CSV headers and screen-reader names. Blocks are separated by line breaks. */
export function toPlain(doc: RichDoc | InlineDoc | readonly InlineNode[], options: PlainTextOptions = {}): string {
  if (Array.isArray(doc)) return inline(doc as readonly InlineNode[], options);
  return (doc as RichDoc).content.map((node) => block(node, options)).join('\n');
}

/** `MigrationContext.htmlToPlain`. */
export function htmlToPlain(html: string, options: PlainTextOptions = {}): string {
  return toPlain(fromHtml(html).doc, options);
}
