import {
  ThemeColorTokenSchema, isSafeHref, tokenVar,
  type ColorValue, type InlineDoc, type InlineNode, type ListItemNode, type Mark, type RichBlockNode, type RichDoc,
} from '@form/schema';

/*
 * The HTML flavour a copy puts on the clipboard for other apps (ADR-0002 §7). The builder stores and pastes the AST
 * itself; this only writes HTML, escaping every text and attribute value, and nothing here hands HTML to the DOM.
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function cssColor(value: ColorValue): string | null {
  if (typeof value === 'string') return /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : null;
  const token = 'token' in value ? ThemeColorTokenSchema.safeParse(value.token) : null;
  return token?.success ? `var(${tokenVar(token.data)})` : null;
}

function open(mark: Mark): [string, string] | null {
  switch (mark.type) {
    case 'bold':
      return ['<b>', '</b>'];
    case 'italic':
      return ['<i>', '</i>'];
    case 'underline':
      return ['<u>', '</u>'];
    case 'strike':
      return ['<s>', '</s>'];
    case 'code':
      return ['<code>', '</code>'];
    case 'link':
      return isSafeHref(mark.attrs.href) ? [`<a href="${escape(mark.attrs.href)}">`, '</a>'] : null;
    case 'textColor':
    case 'highlight': {
      const color = cssColor(mark.attrs.color);
      if (!color) return null;
      return [`<span style="${mark.type === 'textColor' ? 'color' : 'background-color'}: ${color}">`, '</span>'];
    }
  }
}

/**
 * HTML collapses runs of spaces and drops them at line edges; text that would lose a space is wrapped so it keeps
 * them. A line break inside a text node is a `<br>` (BL-053).
 */
function text(t: string, prev: InlineNode | undefined, next: InlineNode | undefined): string {
  const collapsesLeading = !prev || prev.type === 'hardBreak' || (prev.type === 'text' && /[ \t]$/.test(prev.text));
  const atLineEnd = !next || next.type === 'hardBreak';
  const pre = /[ \t]{2}|\t/.test(t) || (collapsesLeading && /^ /.test(t)) || (atLineEnd && / $/.test(t));
  const body = escape(t).replace(/\r\n?|\n/g, '<br>');
  return pre ? `<span style="white-space: pre-wrap">${body}</span>` : body;
}

function inline(nodes: readonly InlineNode[] | undefined): string {
  const list = nodes ?? [];
  return list.map((node, i) => {
    if (node.type === 'hardBreak') return '<br>';
    if (node.type !== 'text') return escape(node.attrs.fallback ?? '');
    const tags = (node.marks ?? []).map(open).filter((t) => t !== null);
    return tags.map(([o]) => o).join('') + text(node.text, list[i - 1], list[i + 1]) + tags.map(([, c]) => c).reverse().join('');
  }).join('');
}

const align = (a: string | undefined) => (a ? ` style="text-align: ${a}"` : '');

/** A list item's first paragraph is written inline; an empty or aligned one stays a paragraph, so it is not lost (BL-053). */
function item(node: ListItemNode): string {
  const [first, ...rest] = node.content;
  const head = first?.type === 'paragraph' && !first.attrs && first.content?.length ? inline(first.content) : first ? block(first) : '';
  return `<li>${head}${rest.map(block).join('')}</li>`;
}

function block(node: RichBlockNode): string {
  switch (node.type) {
    case 'paragraph':
      return `<p${align(node.attrs?.align)}>${node.content?.length ? inline(node.content) : '<br>'}</p>`;
    case 'heading':
      return `<h${node.attrs.level}${align(node.attrs.align)}>${node.content?.length ? inline(node.content) : '<br>'}</h${node.attrs.level}>`;
    case 'bulletList':
      return `<ul>${node.content.map(item).join('')}</ul>`;
    case 'orderedList':
      return `<ol${node.attrs?.start !== undefined ? ` start="${node.attrs.start}"` : ''}>${node.content.map(item).join('')}</ol>`;
    case 'blockquote':
      return `<blockquote>${node.content.map(block).join('')}</blockquote>`;
    case 'horizontalRule':
      return '<hr>';
    case 'image':
      return '';
  }
}

/** AST → clipboard HTML. A single plain paragraph stays inline, so it pastes into a line elsewhere. */
export function toHtml(doc: RichDoc | InlineDoc): string {
  const [first, ...rest] = doc.content;
  if (!first) return '';
  if (!rest.length && first.type === 'paragraph' && !first.attrs) return inline(first.content);
  return doc.content.map(block).join('');
}
