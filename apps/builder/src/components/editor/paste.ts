import type { JSONContent } from '@tiptap/core';
import { PASTE_PROFILE, fromHtml, normalizeInlineDoc, normalizeRichDoc, type RichDoc } from '@form/schema';

function plainDoc(text: string): RichDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return normalizeRichDoc({ type: 'doc', content: lines.map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }, PASTE_PROFILE);
}

/**
 * Clipboard data → editor content. HTML goes through the `fromHtml` allowlist with the paste profile (bold, italic,
 * underline, links and lists); a single pasted paragraph is inserted as inline content so it joins the current line.
 */
export function clipboardContent(html: string, text: string, kind: 'inline' | 'rich'): JSONContent[] {
  const doc = html.trim() ? fromHtml(html, PASTE_PROFILE).doc : plainDoc(text);
  const [first, ...rest] = doc.content;
  if (kind === 'inline' || (first?.type === 'paragraph' && !rest.length)) {
    return (normalizeInlineDoc(doc, PASTE_PROFILE).content[0].content ?? []) as JSONContent[];
  }
  return doc.content as JSONContent[];
}
