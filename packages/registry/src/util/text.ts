import type { InlineDoc, InlineNode, LabelText } from '@form/schema';

const inlineNodeText = (node: InlineNode): string => {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'hardBreak':
      return ' ';
    case 'pipe':
    case 'var':
      return node.attrs.fallback ?? '';
  }
};

/** Plain text of a one-paragraph doc; pipes and template variables show their fallback. */
export const inlineText = (doc: InlineDoc): string => (doc.content[0].content ?? []).map(inlineNodeText).join('');

export const labelText = (label: LabelText): string =>
  typeof label === 'string'
    ? label
    : label.map((part) => (typeof part === 'string' ? part : 'pipe' in part ? (part.pipe.fallback ?? '') : (part.var.fallback ?? ''))).join('');

/** Lower-cases A-Z only, so the result never depends on the host's Unicode tables. */
export const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
