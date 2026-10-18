import { Parser } from 'htmlparser2';
import type { SafeHref, TextAlign } from '../v2/ids.ts';
import type { InlineDoc, InlineNode, Mark, RichDoc, TextNode } from '../v2/rich-text.ts';
import { RICH_TEXT_LIMITS } from '../v2/zod/_util.ts';
import { isSafeHref } from '../v2/zod/primitives.ts';
import { parseCssColor } from './color.ts';
import { RICH_TEXT_PROFILE, normalizeInlineDoc, normalizeRichDoc, type MarkType, type RichTextProfile } from './normalize.ts';

/** `dropped` names what the allowlist removed (`<script>`, `onerror`, `href` …), for migration notes. */
export interface HtmlConversion<D> { doc: D; dropped: string[] }

/** Elements whose whole content is discarded. */
const SKIP = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
  'head', 'title', 'meta', 'link', 'base', 'xmp', 'noembed', 'noframes', 'canvas', 'audio', 'video', 'source', 'track',
  'picture', 'map', 'area', 'button', 'input', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output',
  'progress', 'meter', 'dialog', 'portal', 'slot', 'param',
]);
/** Paragraph boundaries. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address',
  'details', 'summary', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'form',
  'fieldset', 'legend', 'center', 'body', 'html', 'hgroup', 'search',
]);
/** Elements that open a list, item or quote container while the depth limits allow it. */
const CONTAINERS = new Set(['ul', 'ol', 'li', 'blockquote']);
const HEADINGS: Readonly<Record<string, 1 | 2 | 3>> = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };
const TAG_MARKS: Readonly<Record<string, MarkType>> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', ins: 'underline',
  s: 'strike', strike: 'strike', del: 'strike', code: 'code', kbd: 'code', samp: 'code', tt: 'code',
};
/** Inline wrappers that are unwrapped without a note. */
const TRANSPARENT = new Set([
  'span', 'font', 'a', 'sub', 'sup', 'small', 'big', 'abbr', 'acronym', 'q', 'cite', 'dfn', 'var', 'label', 'mark',
  'bdi', 'bdo', 'time', 'data', 'nobr', 'wbr', 'o:p', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'colgroup', 'col',
]);
/** URL-bearing attributes worth a note when they are dropped. */
const URL_ATTRS = new Set(['src', 'srcset', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'data', 'ping', 'lowsrc', 'dynsrc']);
const ALIGNS: Readonly<Record<string, TextAlign>> = { left: 'left', center: 'center', right: 'right', start: 'left', end: 'right' };
const WS = /[ \t\n\r\f]+/g;

/**
 * One open element. `marks`, `pre`, `inMarker` and the block attributes are resolved against the parent frame when the
 * frame is pushed, so reading them for a text run costs the same at any nesting depth.
 */
interface Frame {
  set: Mark[];
  unset: MarkType[];
  marks: Mark[];
  skip: boolean;
  marker: boolean;
  inMarker: boolean;
  block: boolean;
  container: boolean;
  pre: boolean;
  heading?: 1 | 2 | 3 | undefined;
  align?: TextAlign | undefined;
  msoLevel?: number | undefined;
}

interface Loose { type: string; attrs?: Record<string, unknown>; content: unknown[] }
type Container = { kind: 'root' | 'list' | 'item' | 'quote'; node: Loose };
interface Pending { node: InlineNode; pre: boolean }
/** The text node being read: htmlparser2 reports decoded text in several callbacks (one per entity), all one node. */
interface TextRun { pending: Pending & { node: TextNode }; cost: number; breaks: number; length: number; cr: boolean }

function parseStyle(style: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of (style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  return out;
}

function addMark(frame: Frame, mark: Mark) {
  frame.set = [...frame.set.filter((m) => m.type !== mark.type), mark];
  frame.unset = frame.unset.filter((t) => t !== mark.type);
}

function removeMark(frame: Frame, type: MarkType) {
  frame.set = frame.set.filter((m) => m.type !== type);
  if (!frame.unset.includes(type)) frame.unset.push(type);
}

function applyStyle(frame: Frame, style: Map<string, string>) {
  for (const [prop, type] of [['color', 'textColor'], ['background-color', 'highlight'], ['background', 'highlight']] as const) {
    const value = style.get(prop);
    if (value === undefined) continue;
    const color = parseCssColor(value);
    if (color === null) removeMark(frame, type);
    else if (color !== undefined) addMark(frame, { type, attrs: { color } });
  }
  const weight = style.get('font-weight')?.toLowerCase();
  if (weight && /^(bold|bolder|[6-9]00)$/.test(weight)) addMark(frame, { type: 'bold' });
  else if (weight && /^(normal|lighter|[1-5]00)$/.test(weight)) removeMark(frame, 'bold');
  const fontStyle = style.get('font-style')?.toLowerCase();
  if (fontStyle === 'italic' || fontStyle?.startsWith('oblique')) addMark(frame, { type: 'italic' });
  else if (fontStyle === 'normal') removeMark(frame, 'italic');
  const decoration = (style.get('text-decoration-line') ?? style.get('text-decoration'))?.toLowerCase();
  if (decoration !== undefined) {
    if (decoration.includes('underline')) addMark(frame, { type: 'underline' });
    if (decoration.includes('line-through')) addMark(frame, { type: 'strike' });
    if (/^none\b/.test(decoration)) {
      removeMark(frame, 'underline');
      removeMark(frame, 'strike');
    }
  }
}

function collapse(items: Pending[]): InlineNode[] {
  const out: Pending[] = [];
  const trimTrailing = () => {
    const last = out.at(-1);
    if (!last || last.pre || last.node.type !== 'text' || !last.node.text.endsWith(' ')) return;
    const text = last.node.text.slice(0, -1);
    if (text) last.node = { ...last.node, text };
    else out.pop();
  };
  let space = true;
  for (const { node, pre } of items) {
    if (node.type !== 'text') {
      if (node.type === 'hardBreak') trimTrailing();
      space = node.type === 'hardBreak';
      out.push({ node, pre });
    } else if (pre) {
      node.text.replace(/\r\n?/g, '\n').split('\n').forEach((part, i) => {
        if (i) out.push({ node: { type: 'hardBreak' }, pre });
        if (part) out.push({ node: { ...node, text: part }, pre });
      });
      space = false;
    } else {
      let text = node.text.replace(WS, ' ');
      if (space && text.startsWith(' ')) text = text.slice(1);
      if (!text) continue;
      out.push({ node: { ...node, text }, pre });
      space = text.endsWith(' ');
    }
  }
  trimTrailing();
  return out.map((p) => p.node);
}

const MAX_TEXT = 50_000;

/** Pre text becomes a text node per line with breaks between; long text is split into 50k-character nodes. */
const textCost = (breaks: number, length: number, pre: boolean) => 1 + 2 * (pre ? breaks : 0) + Math.floor(length / MAX_TEXT);

/** Line breaks in one chunk of a run; a `\r\n` split across two callbacks is one break, counted with the `\r`. */
const chunkBreaks = (text: string, afterCr: boolean) =>
  (text.match(/\r\n?|\n/g)?.length ?? 0) - (afterCr && text.startsWith('\n') ? 1 : 0);

const isOrderedMarker = (marker: string) => /^\(?([0-9]{1,4}|[a-z]{1,4})[.)]$/i.test(marker.replace(/[\s ]+/g, ''));

class Reader {
  readonly root: Loose = { type: 'doc', content: [] };
  readonly dropped = new Set<string>();
  private frames: Frame[] = [];
  private containers: Container[] = [{ kind: 'root', node: this.root }];
  private inline: Pending[] = [];
  private skipping = 0;
  private marker = '';
  private wordLists: Array<{ level: number; list: Loose }> = [];
  private lists = 0;
  private quotes = 0;
  private nodes = 0;
  /** Budget taken by the pending inline run, its paragraph included; given back if the run turns out to be blank. */
  private reserved = 0;
  private exhausted = false;
  private run: TextRun | null = null;

  /**
   * Every node the AST can end up with counts, including the empty paragraph a list item may get. Once the limit is
   * hit everything after it is dropped, so the document is cut at one point rather than thinned out.
   */
  private budget(n = 1): boolean {
    if (!this.exhausted && this.nodes + n <= RICH_TEXT_LIMITS.maxNodes) {
      this.nodes += n;
      return true;
    }
    this.exhausted = true;
    this.dropped.add('content beyond the node limit');
    return false;
  }

  /** The first inline node of a run also reserves its paragraph, so hitting the limit truncates the run instead of dropping it. */
  private reserve(n: number): boolean {
    const cost = this.inline.length ? n : n + 1;
    if (!this.budget(cost)) return false;
    this.reserved += cost;
    return true;
  }

  private push(frame: Frame) {
    const parent = this.frames.at(-1);
    frame.inMarker = frame.marker || (parent?.inMarker ?? false);
    if (!frame.skip) {
      const marks = new Map<MarkType, Mark>((parent?.marks ?? []).map((m) => [m.type, m]));
      for (const t of frame.unset) marks.delete(t);
      for (const m of frame.set) marks.set(m.type, m);
      frame.marks = [...marks.values()];
      frame.pre ||= parent?.pre ?? false;
      /* A container starts a fresh block context: nothing above it applies to the blocks inside. */
      if (frame.container) {
        frame.heading = undefined;
        frame.align = undefined;
        frame.msoLevel = undefined;
      } else {
        frame.heading ??= parent?.heading;
        frame.align ??= parent?.align;
        frame.msoLevel ??= parent?.msoLevel;
      }
    }
    this.frames.push(frame);
  }

  private top(): Container {
    return this.containers.at(-1) ?? { kind: 'root', node: this.root };
  }

  /** Puts a block (or a list/quote container) into the innermost container. */
  private append(node: Loose) {
    const top = this.top();
    if (top.kind === 'list') {
      top.node.content.push({ type: 'listItem', content: [node] });
    } else {
      top.node.content.push(node);
      if (top.kind === 'root') this.wordLists = [];
    }
  }

  private attach(node: Loose) {
    const top = this.top();
    if (top.kind === 'list') {
      const last = top.node.content.at(-1) as Loose | undefined;
      if (last) last.content.push(node);
      else top.node.content.push({ type: 'listItem', content: [node] });
    } else {
      top.node.content.push(node);
      if (top.kind === 'root') this.wordLists = [];
    }
  }

  /** Word exports lists as `<p style="mso-list:l0 level2 …">` paragraphs with the bullet in a `mso-list:Ignore` span. */
  private appendWordItem(node: Loose, rawLevel: number, marker: string) {
    if (!this.budget(2)) {
      this.root.content.push(node);
      return;
    }
    const level = Math.min(RICH_TEXT_LIMITS.maxListDepth, Math.max(1, rawLevel));
    const type = isOrderedMarker(marker) ? 'orderedList' : 'bulletList';
    const stack = this.wordLists;
    while ((stack.at(-1)?.level ?? 0) > level) stack.pop();
    if (stack.at(-1)?.level === level && stack.at(-1)?.list.type !== type) stack.pop();
    let top = stack.at(-1);
    if (!top || top.level < level) {
      const list: Loose = { type, content: [] };
      const parent = top?.list.content.at(-1) as Loose | undefined;
      if (parent) parent.content.push(list);
      else this.root.content.push(list);
      top = { level, list };
      stack.push(top);
    }
    top.list.content.push({ type: 'listItem', content: [node] });
  }

  flush(closing?: Frame) {
    const items = this.inline;
    this.inline = [];
    this.run = null;
    const marker = this.marker;
    this.marker = '';
    const reserved = this.reserved;
    this.reserved = 0;
    const meaningful = items.some(({ node, pre }) => pre || node.type !== 'text' || node.text.replace(WS, '') !== '');
    if (!meaningful) {
      this.nodes -= reserved;
      return;
    }
    const { heading, align, msoLevel } = closing ?? this.frames.at(-1) ?? {};
    const attrs = { ...(heading ? { level: heading } : {}), ...(align ? { align } : {}) };
    const node: Loose = { type: heading ? 'heading' : 'paragraph', attrs, content: collapse(items) };
    if (msoLevel !== undefined && this.top().kind === 'root') this.appendWordItem(node, msoLevel, marker);
    else this.append(node);
  }

  onopentag = (name: string, attribs: Record<string, string>) => {
    this.run = null;
    const frame: Frame = { set: [], unset: [], marks: [], skip: false, marker: false, inMarker: false, block: false, container: false, pre: false };
    const own = (key: string): string | undefined => (Object.hasOwn(attribs, key) ? attribs[key] : undefined);
    if (this.skipping > 0 || SKIP.has(name)) {
      if (this.skipping === 0) this.dropped.add(`<${name}>`);
      frame.skip = true;
      this.skipping += 1;
      this.push(frame);
      return;
    }
    for (const attr of Object.keys(attribs)) {
      if (attr.startsWith('on') || URL_ATTRS.has(attr)) this.dropped.add(attr);
    }
    const style = parseStyle(own('style'));
    if (style.get('mso-list')?.toLowerCase() === 'ignore') {
      frame.skip = true;
      frame.marker = true;
      this.skipping += 1;
      this.push(frame);
      return;
    }
    if (!(name in TAG_MARKS) && !(name in HEADINGS) && !BLOCK.has(name) && !TRANSPARENT.has(name)) this.dropped.add(`<${name}>`);

    const heading = HEADINGS[name];
    if (name === 'br') {
      if (this.reserve(1)) this.inline.push({ node: { type: 'hardBreak' }, pre: false });
    } else if (name === 'hr') {
      this.flush();
      if (this.budget()) this.append({ type: 'horizontalRule', content: [] });
    } else if (name === 'img') {
      this.dropped.add('<img>');
    } else if ((name === 'ul' || name === 'ol') && this.lists < RICH_TEXT_LIMITS.maxListDepth && this.budget()) {
      this.flush();
      const start = name === 'ol' ? Number.parseInt(own('start') ?? '', 10) : Number.NaN;
      const list: Loose = { type: name === 'ul' ? 'bulletList' : 'orderedList', ...(Number.isFinite(start) ? { attrs: { start } } : {}), content: [] };
      this.attach(list);
      this.containers.push({ kind: 'list', node: list });
      this.lists += 1;
      frame.container = true;
    } else if (name === 'li' && this.top().kind === 'list' && this.budget(2)) {
      this.flush();
      const item: Loose = { type: 'listItem', content: [] };
      this.top().node.content.push(item);
      this.containers.push({ kind: 'item', node: item });
      frame.container = true;
    } else if (name === 'blockquote' && this.quotes === 0 && this.budget()) {
      this.flush();
      const quote: Loose = { type: 'blockquote', content: [] };
      this.attach(quote);
      this.containers.push({ kind: 'quote', node: quote });
      this.quotes += 1;
      frame.container = true;
    } else if (heading || name === 'pre' || BLOCK.has(name) || CONTAINERS.has(name)) {
      /* Lists past the depth limit, quotes in quotes and items outside a list are plain blocks: the tree stays shallow. */
      this.flush();
      frame.block = true;
      frame.pre = name === 'pre';
      if (heading) frame.heading = heading;
    }

    const tagMark = TAG_MARKS[name];
    if (tagMark) addMark(frame, { type: tagMark } as Mark);
    if (name === 'a') {
      const href = own('href')?.trim();
      if (href && isSafeHref(href)) addMark(frame, { type: 'link', attrs: { href: href as SafeHref } });
      else if (href !== undefined) this.dropped.add('href');
    }
    if (name === 'font' && own('color') !== undefined) {
      const color = parseCssColor(own('color') ?? '');
      if (color) addMark(frame, { type: 'textColor', attrs: { color } });
    }
    applyStyle(frame, style);
    if (/^(pre|pre-wrap|break-spaces)$/.test(style.get('white-space')?.toLowerCase() ?? '')) frame.pre = true;
    if (frame.block || frame.container) {
      const align = ALIGNS[(style.get('text-align') ?? own('align') ?? '').toLowerCase()];
      if (align && frame.block) frame.align = align;
      const level = /level(\d+)/i.exec(style.get('mso-list') ?? '')?.[1];
      if (level && frame.block) frame.msoLevel = Number(level);
    }
    this.push(frame);
  };

  ontext = (text: string) => {
    const top = this.frames.at(-1);
    if (this.skipping > 0) {
      if (top?.inMarker) this.marker += text;
      return;
    }
    const pre = top?.pre ?? false;
    /*
     * The budget is charged per text node after decoding (BL-052), not per callback: `a&amp;b` is one node. The run
     * keeps its break count and length so each callback costs only its own chunk.
     */
    const run = this.run;
    const cr = text.endsWith('\r');
    if (run) {
      const breaks = run.breaks + chunkBreaks(text, run.cr);
      const length = run.length + text.length;
      const cost = textCost(breaks, length, pre);
      if (!this.reserve(cost - run.cost)) return;
      run.pending.node = { ...run.pending.node, text: run.pending.node.text + text };
      Object.assign(run, { cost, breaks, length, cr });
      return;
    }
    const breaks = chunkBreaks(text, false);
    const cost = textCost(breaks, text.length, pre);
    if (!this.reserve(cost)) return;
    const pending: TextRun['pending'] = { node: { type: 'text', text, marks: top?.marks ?? [] }, pre };
    this.inline.push(pending);
    this.run = { pending, cost, breaks, length: text.length, cr };
  };

  onclosetag = () => {
    this.run = null;
    const frame = this.frames.pop();
    if (!frame) return;
    if (frame.skip) {
      this.skipping -= 1;
      return;
    }
    if (frame.block || frame.container) this.flush(frame);
    if (frame.container) {
      const kind = this.containers.pop()?.kind;
      if (kind === 'list') this.lists -= 1;
      else if (kind === 'quote') this.quotes -= 1;
    }
  };
}

/**
 * v1 HTML → `RichDoc` through an allowlist. The HTML is tokenised by htmlparser2 and never reaches a DOM, so nothing in
 * it can run or load. Unknown elements are unwrapped to their text; `<font color>` and `<span style="color">` become
 * `textColor`; links keep only http(s), mailto and tel targets.
 */
export function fromHtml(html: string, profile: RichTextProfile = RICH_TEXT_PROFILE): HtmlConversion<RichDoc> {
  const reader = new Reader();
  const parser = new Parser(reader, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  reader.flush();
  return { doc: normalizeRichDoc(reader.root, profile), dropped: [...reader.dropped] };
}

/** v1 HTML → `InlineDoc` (labels, headings); separate blocks are joined with hard breaks. */
export function fromHtmlInline(html: string, profile: RichTextProfile = RICH_TEXT_PROFILE): HtmlConversion<InlineDoc> {
  const { doc, dropped } = fromHtml(html, profile);
  return { doc: normalizeInlineDoc(doc, profile), dropped };
}

/** `MigrationContext.htmlToInline`. */
export function htmlToInline(html: string): InlineNode[] {
  return fromHtmlInline(html).doc.content[0].content ?? [];
}
