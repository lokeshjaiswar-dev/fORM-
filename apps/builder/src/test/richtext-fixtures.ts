import type {
  AssetId, BlockId, BulletListNode, HexColor, InlineDoc, InlineNode, ListItemNode, Mark, OrderedListNode, ParagraphNode, RichBlockNode, RichDoc, SafeHref, SafeUrl,
} from '@form/schema';

/** 51 canonical ASTs (already normalised) for the editor ↔ AST and AST ↔ v1 HTML round trips. */
export interface RichTextFixture {
  name: string;
  kind: 'inline' | 'rich';
  doc: InlineDoc | RichDoc;
  /** False when the doc holds nodes v1 HTML cannot carry (pipes, vars, images). */
  v1: boolean;
}

const t = (text: string, ...marks: Mark[]): InlineNode => (marks.length ? { type: 'text', text, marks } : { type: 'text', text });
const br: InlineNode = { type: 'hardBreak' };
const b: Mark = { type: 'bold' };
const i: Mark = { type: 'italic' };
const u: Mark = { type: 'underline' };
const s: Mark = { type: 'strike' };
const code: Mark = { type: 'code' };
const link = (href: string): Mark => ({ type: 'link', attrs: { href: href as SafeHref } });
const fg = (color: string): Mark => ({ type: 'textColor', attrs: { color: color as HexColor } });
const token = (name: 'accent' | 'muted' | 'error' | 'success' | 'text'): Mark => ({ type: 'textColor', attrs: { color: { token: name } } });
const hl = (color: string): Mark => ({ type: 'highlight', attrs: { color: color as HexColor } });
const pipe = (fallback?: string): InlineNode => ({ type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'name' as BlockId }, ...(fallback ? { fallback } : {}) } });
const v = (name: `org.${string}`): InlineNode => ({ type: 'var', attrs: { name } });

const p = (...content: InlineNode[]): ParagraphNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const pa = (align: 'left' | 'center' | 'right', ...content: InlineNode[]): RichBlockNode => ({ type: 'paragraph', attrs: { align }, content });
const h = (level: 1 | 2 | 3, ...content: InlineNode[]): RichBlockNode => ({ type: 'heading', attrs: { level }, content });
const li = (...content: ListItemNode['content']): ListItemNode => ({ type: 'listItem', content });
const ul = (...items: ListItemNode[]): BulletListNode => ({ type: 'bulletList', content: items });
const ol = (start: number | undefined, ...items: ListItemNode[]): OrderedListNode => (start === undefined ? { type: 'orderedList', content: items } : { type: 'orderedList', attrs: { start }, content: items });
const quote = (...content: ParagraphNode[]): RichBlockNode => ({ type: 'blockquote', content });
const hr: RichBlockNode = { type: 'horizontalRule' };

const inline = (name: string, content: InlineNode[], v1 = true, align?: 'left' | 'center' | 'right'): RichTextFixture => ({
  name, kind: 'inline', v1,
  doc: { type: 'doc', content: [{ type: 'paragraph', ...(align ? { attrs: { align } } : {}), ...(content.length ? { content } : {}) }] },
});
const rich = (name: string, content: RichBlockNode[], v1 = true): RichTextFixture => ({ name, kind: 'rich', v1, doc: { type: 'doc', content } });

const INLINE: RichTextFixture[] = [
  inline('empty label', []),
  inline('plain label', [t('What is your name?')]),
  inline('bold word', [t('Your '), t('full', b), t(' name')]),
  inline('italic and underline', [t('Pick ', i), t('one', i, u)]),
  inline('strike', [t('old', s), t(' new')]),
  inline('every simple mark', [t('all', b, i, u, s)]),
  inline('code', [t('Use '), t('YYYY-MM-DD', code)]),
  inline('code with bold', [t('x', b, code)]),
  inline('https link', [t('Read the '), t('terms', link('https://example.com/terms?x=1&y=2'))]),
  inline('mailto and tel links', [t('mail', link('mailto:help@example.com')), t(' or '), t('call', link('tel:+91 98765 43210'))]),
  inline('bold link', [t('bold link', b, link('https://example.com'))]),
  inline('hex colour', [t('red', fg('#eb5757'))]),
  inline('token colour', [t('accent', token('accent')), t(' and '), t('muted', token('muted'))]),
  inline('highlight', [t('note', hl('#fdecc8'))]),
  inline('colour and highlight', [t('both', b, fg('#337ea9'), hl('#d3e5ef'))]),
  inline('hard break', [t('Line one'), br, t('line two')]),
  inline('leading break', [br, t('after')]),
  inline('unicode', [t('नमस्ते, தமிழ், اردو and emoji 👩🏽‍💻 ₹499')]),
  inline('markup-like text', [t('<img src=x onerror=alert(1)> & "quotes" \'too\'')]),
  inline('centred', [t('Centre')], true, 'center'),
  inline('pipe and var', [t('Hi '), pipe('there'), t(', welcome to '), v('org.legal_name')], false),
];

const RICH: RichTextFixture[] = [
  rich('empty doc', []),
  rich('one paragraph', [p(t('Hello'))]),
  rich('two paragraphs', [p(t('First')), p(t('Second'))]),
  rich('blank line between', [p(t('a')), p(), p(t('b'))]),
  rich('leading empty paragraph', [p(), p(t('text'))]),
  rich('aligned paragraphs', [pa('center', t('c')), pa('right', t('r')), pa('left', t('l'))]),
  rich('headings', [h(1, t('One')), h(2, t('Two')), h(3, t('Three', i))]),
  rich('aligned heading', [{ type: 'heading', attrs: { level: 2, align: 'center' }, content: [t('Centred')] }]),
  rich('bullet list', [ul(li(p(t('a'))), li(p(t('b', b))))]),
  rich('ordered list', [ol(undefined, li(p(t('one'))), li(p(t('two'))))]),
  rich('ordered list from 3', [ol(3, li(p(t('three'))))]),
  rich('ordered list from 0', [ol(0, li(p(t('zero'))))]),
  rich('nested lists', [ul(li(p(t('a')), ol(undefined, li(p(t('a.1'))), li(p(t('a.2'))))), li(p(t('b'))))]),
  rich('three-deep list', [ul(li(p(t('1')), ul(li(p(t('2')), ul(li(p(t('3'))))))))]),
  rich('item with two paragraphs', [ul(li(p(t('first')), p(t('second'))))]),
  rich('empty list item', [ul(li(p()), li(p(t('x'))))]),
  rich('blockquote', [quote(p(t('Quoted '), t('words', i)))]),
  rich('blockquote with two paragraphs', [quote(p(t('a')), p(t('b')))]),
  rich('rule between', [p(t('above')), hr, p(t('below'))]),
  rich('links in lists', [ul(li(p(t('site', link('https://example.org/a#b'))))), p(t('mail', link('mailto:a@b.example')))]),
  rich('colours in a heading', [h(2, t('Tok', token('accent')), t('en', fg('#9065b0'), hl('#e8deee')))]),
  rich('breaks in paragraphs', [p(t('a'), br, t('b')), p(t('c'))]),
  rich('mixed document', [h(1, t('Event')), p(t('Join us on '), t('Friday', b), t('.')), ul(li(p(t('Bring ID'))), li(p(t('Arrive early', u)))), quote(p(t('See you there'))), hr, p(t('Questions? '), t('Email us', link('mailto:events@example.com')))]),
  rich('long text', [p(t('lorem ipsum '.repeat(200).trim()))]),
  rich('pipe in paragraph', [p(t('Thanks, '), pipe(), t('!'))], false),
  rich('var in list', [ul(li(p(t('From '), v('org.name'))))], false),
  rich('image', [p(t('Logo:')), { type: 'image', attrs: { asset: { assetId: 'asset_1' as AssetId, alt: 'Logo' }, widthPct: 40, align: 'center' } }], false),
  rich('image with link', [{ type: 'image', attrs: { asset: { assetId: 'asset_2' as AssetId, decorative: true }, href: 'https://example.com' as SafeUrl } }], false),
  rich('empty heading', [{ type: 'heading', attrs: { level: 2 } }, p(t('after'))]),
  rich('heading then list', [h(3, t('Steps')), ol(undefined, li(p(t('Read'))), li(p(t('Sign', b, i))))]),
];

export const RICH_TEXT_FIXTURES: readonly RichTextFixture[] = [...INLINE, ...RICH];
