import type { JSONContent } from '@tiptap/core';
import {
  PASTE_PROFILE, RICH_TEXT_PROFILE, RichDocSchema, fromHtml, normalizeInlineDoc, normalizeRichDoc, toPlain, type RichDoc,
} from '@form/schema';
import { toV1Html } from '@/lib/v1html';

/** Builder-internal clipboard type: copy and paste between builder editors keeps every mark and node the AST allows. */
export const CLIPBOARD_TYPE = 'application/x-form-rich-text+json';
const FORMAT = 'fORM-rich-text';

export interface ClipboardData {
  html: string;
  text: string;
  /** The `CLIPBOARD_TYPE` entry, if any. */
  internal: string;
}

function plainDoc(text: string): RichDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return normalizeRichDoc({ type: 'doc', content: lines.map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }, PASTE_PROFILE);
}

/** A copied selection (editor JSON blocks) as clipboard entries: the AST payload for builder editors, HTML and text for other apps. */
export function clipboardPayload(content: unknown): ClipboardData {
  const doc = normalizeRichDoc({ type: 'doc', content });
  return { internal: JSON.stringify({ format: FORMAT, version: 1, doc }), html: toV1Html(doc), text: toPlain(doc) };
}

/** The builder payload, normalized and limit-checked again: any page can write this type to the clipboard. */
function internalDoc(payload: string): RichDoc | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { format, version, doc } = parsed as Record<string, unknown>;
  if (format !== FORMAT || version !== 1) return null;
  const normalized = normalizeRichDoc(doc, RICH_TEXT_PROFILE);
  return RichDocSchema.safeParse(normalized).success ? normalized : null;
}

/**
 * Clipboard data → editor content. The builder's own payload keeps full formatting (rich-text profile). Anything else
 * is external: HTML goes through the `fromHtml` allowlist with the paste profile (bold, italic, underline, links and
 * lists). A single pasted paragraph is inserted as inline content so it joins the current line.
 */
export function clipboardContent(data: ClipboardData, kind: 'inline' | 'rich'): JSONContent[] {
  const internal = internalDoc(data.internal);
  const profile = internal ? RICH_TEXT_PROFILE : PASTE_PROFILE;
  const doc = internal ?? (data.html.trim() ? fromHtml(data.html, PASTE_PROFILE).doc : plainDoc(data.text));
  const [first, ...rest] = doc.content;
  if (kind === 'inline' || (first?.type === 'paragraph' && !rest.length)) {
    return (normalizeInlineDoc(doc, profile).content[0].content ?? []) as JSONContent[];
  }
  return doc.content as JSONContent[];
}
