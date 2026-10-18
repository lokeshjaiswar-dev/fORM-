import type { SafeHref, TextAlign } from '../v2/ids.ts';
import type {
  BlockquoteNode, BulletListNode, HeadingNode, InlineDoc, InlineNode, ListItemNode, Mark, OrderedListNode, ParagraphNode,
  RichBlockNode, RichDoc, TextNode,
} from '../v2/rich-text.ts';
import { RICH_TEXT_LIMITS, measureRichText } from '../v2/zod/_util.ts';
import { isSafeHref } from '../v2/zod/primitives.ts';
import { ColorValueSchema, ImageNodeSchema, PipeNodeSchema, VarNodeSchema } from '../v2/zod/rich-text.ts';

export type MarkType = Mark['type'];
export type RichBlockKind = 'heading' | 'bulletList' | 'orderedList' | 'blockquote' | 'horizontalRule' | 'image';

/** Which marks and block nodes survive; anything else is unwrapped to its text or dropped. */
export interface RichTextProfile {
  marks: readonly MarkType[];
  blocks: readonly RichBlockKind[];
  /** pipe and var atoms */
  atoms: boolean;
}

export const MARK_ORDER: readonly MarkType[] = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textColor', 'highlight'];

export const RICH_TEXT_PROFILE: RichTextProfile = {
  marks: MARK_ORDER,
  blocks: ['heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'image'],
  atoms: true,
};

/** Paste from Docs, Word or the web keeps bold, italic, underline, links and lists only. */
export const PASTE_PROFILE: RichTextProfile = {
  marks: ['bold', 'italic', 'underline', 'link'],
  blocks: ['bulletList', 'orderedList'],
  atoms: false,
};

const MAX_TEXT = 50_000;
/** Wrappers nested deeper than this are flattened to their inline content without recursion. */
const MAX_NESTING = 32;
const ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];

type Where = 'root' | 'item' | 'quote';
interface Ctx { profile: RichTextProfile; lists: number; where: Where; depth: number }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const typeOf = (v: unknown): unknown => (isObject(v) ? v.type : undefined);
const attrsOf = (v: unknown): Record<string, unknown> => (isObject(v) && isObject(v.attrs) ? v.attrs : {});

/** Drops `null`/`undefined` attribute values (the editor writes defaults as `null`). */
function present(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined));
}

function alignOf(node: unknown): TextAlign | undefined {
  const align = attrsOf(node).align;
  return ALIGNS.find((a) => a === align);
}

function normalizeMarks(marks: unknown, profile: RichTextProfile): Mark[] {
  const byType = new Map<MarkType, Mark>();
  for (const raw of list(marks)) {
    const type = MARK_ORDER.find((t) => t === typeOf(raw));
    if (!type || !profile.marks.includes(type) || byType.has(type)) continue;
    const attrs = attrsOf(raw);
    if (type === 'link') {
      const href = typeof attrs.href === 'string' ? attrs.href.trim() : '';
      if (isSafeHref(href)) byType.set(type, { type, attrs: { href: href as SafeHref } });
    } else if (type === 'textColor' || type === 'highlight') {
      const color = ColorValueSchema.safeParse(isObject(attrs.color) ? present(attrs.color) : attrs.color);
      if (color.success) byType.set(type, { type, attrs: { color: color.data } });
    } else {
      byType.set(type, { type });
    }
  }
  return MARK_ORDER.flatMap((t) => byType.get(t) ?? []);
}

const sameMarks = (a: readonly Mark[] = [], b: readonly Mark[] = []) => JSON.stringify(a) === JSON.stringify(b);

function textNode(text: string, marks: Mark[]): TextNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

/** Inline content: allowed marks in canonical order, adjacent equal text merged, atoms validated, trailing breaks trimmed. */
export function normalizeInlineNodes(nodes: unknown, profile: RichTextProfile = RICH_TEXT_PROFILE): InlineNode[] {
  const out: InlineNode[] = [];
  const pushText = (text: string, marks: Mark[]) => {
    const last = out.at(-1);
    if (last?.type === 'text' && sameMarks(last.marks, marks) && last.text.length + text.length <= MAX_TEXT) {
      out[out.length - 1] = textNode(last.text + text, marks);
      return;
    }
    for (let i = 0; i < text.length; i += MAX_TEXT) out.push(textNode(text.slice(i, i + MAX_TEXT), marks));
  };
  for (const node of list(nodes)) {
    const type = typeOf(node);
    if (type === 'text') {
      const text = (node as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) pushText(text, normalizeMarks((node as { marks?: unknown }).marks, profile));
    } else if (type === 'hardBreak') {
      out.push({ type: 'hardBreak' });
    } else if ((type === 'pipe' || type === 'var') && profile.atoms) {
      const schema = type === 'pipe' ? PipeNodeSchema : VarNodeSchema;
      const parsed = schema.safeParse({ type, attrs: present(attrsOf(node)) });
      if (parsed.success) out.push(parsed.data);
    }
  }
  while (out.at(-1)?.type === 'hardBreak') out.pop();
  return out;
}

function paragraph(content: InlineNode[], align?: TextAlign): ParagraphNode {
  return { type: 'paragraph', ...(align ? { attrs: { align } } : {}), ...(content.length ? { content } : {}) };
}

function heading(level: number, content: InlineNode[], align?: TextAlign): HeadingNode {
  const clamped = (Math.min(3, Math.max(1, Math.trunc(level) || 1))) as 1 | 2 | 3;
  return { type: 'heading', attrs: { level: clamped, ...(align ? { align } : {}) }, ...(content.length ? { content } : {}) };
}

const INLINE_TYPES = new Set(['text', 'hardBreak', 'pipe', 'var']);
const BLOCK_END = Symbol('block end');

/** Inline nodes under `nodes` in document order, a hard break after each block; iterative, so any depth is safe. */
function inlineDescendants(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  const stack: unknown[] = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop();
    const type = typeOf(node);
    if (node === BLOCK_END) {
      if (out.length && typeOf(out.at(-1)) !== 'hardBreak') out.push({ type: 'hardBreak' });
    } else if (typeof type === 'string' && INLINE_TYPES.has(type)) {
      out.push(node);
    } else {
      stack.push(BLOCK_END);
      const content = list(isObject(node) ? node.content : undefined);
      for (let i = content.length - 1; i >= 0; i--) stack.push(content[i]);
    }
  }
  return out;
}

const deeper = (ctx: Ctx, patch: Partial<Ctx> = {}): Ctx => ({ ...ctx, ...patch, depth: ctx.depth + 1 });

function pushAll<T>(out: T[], items: readonly T[]) {
  for (const item of items) out.push(item);
}

function listItem(node: unknown, ctx: Ctx): ListItemNode {
  const content = blocks(list(isObject(node) ? node.content : undefined), deeper(ctx, { where: 'item' })) as ListItemNode['content'];
  if (content[0]?.type !== 'paragraph') content.unshift(paragraph([]));
  return { type: 'listItem', content };
}

function blocks(nodes: unknown[], ctx: Ctx): RichBlockNode[] {
  if (ctx.depth > MAX_NESTING) {
    const content = normalizeInlineNodes(inlineDescendants(nodes), ctx.profile);
    return content.length ? [paragraph(content)] : [];
  }
  const out: RichBlockNode[] = [];
  let loose: unknown[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    const content = normalizeInlineNodes(loose, ctx.profile);
    if (content.length) out.push(paragraph(content));
    loose = [];
  };
  const allows = (kind: RichBlockKind) => ctx.profile.blocks.includes(kind);
  for (const node of nodes) {
    const type = typeOf(node);
    if (typeof type === 'string' && INLINE_TYPES.has(type)) {
      loose.push(node);
      continue;
    }
    flushLoose();
    const content = list(isObject(node) ? node.content : undefined);
    switch (type) {
      case 'paragraph':
        out.push(paragraph(normalizeInlineNodes(content, ctx.profile), alignOf(node)));
        break;
      case 'heading': {
        const inline = normalizeInlineNodes(content, ctx.profile);
        out.push(allows('heading') && ctx.where === 'root'
          ? heading(Number(attrsOf(node).level), inline, alignOf(node))
          : paragraph(inline, alignOf(node)));
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        if (allows(type) && ctx.where !== 'quote' && ctx.lists < RICH_TEXT_LIMITS.maxListDepth) {
          const inner = { ...ctx, lists: ctx.lists + 1 };
          const items = content.map((item) => listItem(item, inner));
          if (!items.length) break;
          if (type === 'bulletList') {
            out.push({ type, content: items } satisfies BulletListNode);
          } else {
            const start = attrsOf(node).start;
            const attrs = typeof start === 'number' && Number.isInteger(start) && start >= 0 && start !== 1 ? { attrs: { start } } : {};
            out.push({ type, ...attrs, content: items } satisfies OrderedListNode);
          }
        } else {
          for (const item of content) pushAll(out, blocks(list(isObject(item) ? item.content : undefined), deeper(ctx)));
        }
        break;
      }
      case 'blockquote': {
        if (allows('blockquote') && ctx.where === 'root') {
          const inner = blocks(content, deeper(ctx, { where: 'quote' })).filter((b): b is ParagraphNode => b.type === 'paragraph');
          if (inner.length) out.push({ type: 'blockquote', content: inner } satisfies BlockquoteNode);
        } else {
          pushAll(out, blocks(content, deeper(ctx)));
        }
        break;
      }
      case 'horizontalRule':
        if (allows('horizontalRule') && ctx.where === 'root') out.push({ type: 'horizontalRule' });
        break;
      case 'image': {
        if (!allows('image') || ctx.where !== 'root') break;
        const parsed = ImageNodeSchema.safeParse({ type: 'image', attrs: present(attrsOf(node)) });
        if (parsed.success) out.push(parsed.data);
        break;
      }
      default:
        pushAll(out, blocks(content, deeper(ctx)));
    }
  }
  flushLoose();
  if (ctx.where === 'item') return out.filter((b) => b.type === 'paragraph' || b.type === 'bulletList' || b.type === 'orderedList');
  return out;
}

const isEmptyParagraph = (b: RichBlockNode | undefined) => b?.type === 'paragraph' && !b.content && !b.attrs;

interface Tree { type: string; content?: Tree[] }
const NEEDS_CONTENT = new Set(['bulletList', 'orderedList', 'listItem', 'blockquote']);

/**
 * Keeps the first `RICH_TEXT_LIMITS.maxNodes` nodes in document order, as `fromHtml` does: the document is cut at one
 * point. Lists, items and quotes left empty by the cut are dropped; a cut paragraph loses its trailing breaks.
 */
function cut(nodes: readonly Tree[], budget: { left: number }): Tree[] {
  const out: Tree[] = [];
  for (const node of nodes) {
    if (budget.left < 1) break;
    budget.left -= 1;
    if (!node.content) {
      out.push(node);
      continue;
    }
    const content = cut(node.content, budget);
    if (content.length === node.content.length) {
      out.push(node);
      continue;
    }
    if (!content.length && NEEDS_CONTENT.has(node.type)) {
      budget.left += 1;
      break;
    }
    while (content.at(-1)?.type === 'hardBreak') content.pop();
    const { content: _, ...rest } = node;
    out.push(content.length ? { ...rest, content } : rest);
    break;
  }
  return out;
}

function limitNodes<T extends RichDoc | InlineDoc>(doc: T): T {
  if (measureRichText(doc).nodes <= RICH_TEXT_LIMITS.maxNodes) return doc;
  return { ...doc, content: cut(doc.content as Tree[], { left: RICH_TEXT_LIMITS.maxNodes }) } as T;
}

/**
 * Editor JSON (or any loosely built tree) → canonical `RichDoc`. Unknown nodes are unwrapped, marks are filtered to the
 * profile, unsafe links and colours are dropped, lists deeper than 3 are flattened, trailing empty paragraphs removed and
 * the document cut at `RICH_TEXT_LIMITS.maxNodes`.
 */
export function normalizeRichDoc(input: unknown, profile: RichTextProfile = RICH_TEXT_PROFILE): RichDoc {
  const content = blocks(list(isObject(input) ? input.content : undefined), { profile, lists: 0, where: 'root', depth: 0 });
  const limited = limitNodes<RichDoc>({ type: 'doc', content });
  const out = [...limited.content];
  while (isEmptyParagraph(out.at(-1))) out.pop();
  return { type: 'doc', content: out };
}

interface Line { content: InlineNode[]; align?: TextAlign }

function lines(nodes: unknown[], profile: RichTextProfile, out: Line[], depth = 0) {
  if (depth > MAX_NESTING) {
    out.push({ content: normalizeInlineNodes(inlineDescendants(nodes), profile) });
    return;
  }
  let loose: unknown[] = [];
  const flushLoose = () => {
    if (loose.length) out.push({ content: normalizeInlineNodes(loose, profile) });
    loose = [];
  };
  for (const node of nodes) {
    const type = typeOf(node);
    if (typeof type === 'string' && INLINE_TYPES.has(type)) {
      loose.push(node);
      continue;
    }
    flushLoose();
    if (type === 'paragraph' || type === 'heading') {
      const align = alignOf(node);
      out.push({ content: normalizeInlineNodes(isObject(node) ? node.content : undefined, profile), ...(align ? { align } : {}) });
    } else {
      lines(list(isObject(node) ? node.content : undefined), profile, out, depth + 1);
    }
  }
  flushLoose();
}

/** Any doc → exactly one paragraph; separate blocks become hard breaks. */
export function normalizeInlineDoc(input: unknown, profile: RichTextProfile = RICH_TEXT_PROFILE): InlineDoc {
  const out: Line[] = [];
  lines(list(isObject(input) ? input.content : undefined), profile, out);
  while (out.length && !out.at(-1)?.content.length) out.pop();
  while (out.length && !out[0]?.content.length) out.shift();
  const content = normalizeInlineNodes(out.flatMap((line, i) => (i ? [{ type: 'hardBreak' }, ...line.content] : line.content)), profile);
  return limitNodes<InlineDoc>({ type: 'doc', content: [paragraph(content, out[0]?.align)] });
}
