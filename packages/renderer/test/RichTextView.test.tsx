import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fromHtml, type AssetId, type BlockId, type HexColor, type InlineDoc, type RichDoc, type SafeHref, type SafeUrl } from '@form/schema';
import { RichTextView, type RichTextViewProps } from '../src/index.ts';
import { XSS_PAYLOADS } from '@form/schema/test-fixtures';

const html = (props: RichTextViewProps) => renderToStaticMarkup(<RichTextView {...props} />);

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'strong', 'em', 'u', 's', 'code', 'a', 'span']);
const ATTRS = new Set(['href', 'rel', 'target', 'style', 'start']);

describe('RichTextView', () => {
  it('renders every node and mark as elements', () => {
    const doc: RichDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2, align: 'center' }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://a.example' as SafeHref } }, { type: 'textColor', attrs: { color: { token: 'accent' } } }] },
          { type: 'text', text: 'hi', marks: [{ type: 'highlight', attrs: { color: '#fdecc8' as HexColor } }, { type: 'underline' }, { type: 'strike' }, { type: 'code' }] },
        ] },
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }] },
        { type: 'horizontalRule' },
      ],
    };
    expect(html({ doc })).toBe([
      '<h2 style="text-align:center">Title</h2>',
      '<p><strong><em>b</em></strong><br/><a href="https://a.example" rel="noopener noreferrer nofollow" target="_blank"><span style="color:var(--fr-accent)">link</span></a>',
      '<span style="background-color:#fdecc8"><u><s><code>hi</code></s></u></span></p>',
      '<ol start="3"><li><p>item</p></li></ol><blockquote><p>q</p></blockquote><hr/>',
    ].join(''));
  });

  it('renders a label inline, with pipes and vars through the resolver', () => {
    const doc: InlineDoc = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hi ' },
      { type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'name' as BlockId }, fallback: 'there' } },
      { type: 'text', text: ', ' },
      { type: 'var', attrs: { name: 'org.legal_name', fallback: 'us' } },
    ] }] };
    expect(html({ doc, inline: true })).toBe('Hi there, us');
    expect(html({ doc, inline: true, resolve: { pipe: () => 'Asha', var: () => 'Acme' } })).toBe('Hi Asha, Acme');
  });

  it('joins blocks with breaks in inline mode', () => {
    expect(html({ doc: fromHtml('<p>a</p><ul><li>b</li></ul>').doc, inline: true })).toBe('a<br/>b');
  });

  it('keeps empty lines visible, as the editor shows them', () => {
    expect(html({ doc: fromHtml('<div>a</div><div><br></div><div>b</div>').doc })).toBe('<p>a</p><p><br/></p><p>b</p>');
    const doc: RichDoc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 } }, { type: 'paragraph', content: [] }] };
    expect(html({ doc })).toBe('<h2><br/></h2><p><br/></p>');
  });

  it('re-checks links and colours at render time', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      { type: 'text', text: 'y', marks: [{ type: 'textColor', attrs: { color: 'red;background:url(x)' } }] },
      { type: 'text', text: 'z', marks: [{ type: 'textColor', attrs: { color: { token: 'nope' } } }, { type: 'highlight', attrs: { color: { ref: 'brand.primary' } } }] },
    ] }] } as unknown as RichDoc;
    expect(html({ doc })).toBe('<p>xyz</p>');
    expect(html({ doc, resolve: { brand: () => '#123456' } })).toBe('<p>xy<span style="background-color:#123456">z</span></p>');
  });

  it('renders images only through the asset resolver', () => {
    const doc: RichDoc = { type: 'doc', content: [{ type: 'image', attrs: { asset: { assetId: 'a1' as AssetId, alt: 'Logo' }, widthPct: 50, href: 'https://a.example' as SafeUrl } }] };
    expect(html({ doc })).toBe('');
    expect(html({ doc, resolve: { asset: () => '/assets/a1' } })).toContain(
      '<figure><a href="https://a.example" rel="noopener noreferrer nofollow" target="_blank"><img src="/assets/a1" alt="Logo" style="width:50%"/></a></figure>',
    );
  });
});

describe('XSS corpus through fromHtml → RichTextView', () => {
  it('has at least 150 payloads', () => {
    expect(XSS_PAYLOADS.length).toBeGreaterThanOrEqual(150);
  });

  it.each(XSS_PAYLOADS.map((payload, i) => [i, payload] as const))('payload %i renders no handler, no unsafe URL and no foreign element', (_, payload) => {
    const { doc } = fromHtml(payload);
    for (const markup of [html({ doc }), html({ doc, inline: true })]) {
      for (const [, tag = '', attrs = ''] of markup.matchAll(/<([a-z0-9]+)((?:\s[^>]*)?)\/?>/gi)) {
        expect(TAGS).toContain(tag.toLowerCase());
        for (const [, name = '', value = ''] of attrs.matchAll(/\s([^\s=]+)="([^"]*)"/g)) {
          expect(ATTRS).toContain(name);
          if (name === 'href') expect(value).toMatch(/^(https?:\/\/[a-z0-9.-]+([/?#]|$)|mailto:|tel:)/i);
          if (name === 'style') expect(value).toMatch(/^(color|background-color):(#[0-9a-f]{6,8}|var\(--fr-[a-zA-Z]+\))$|^text-align:(left|center|right)$/);
        }
      }
      const tags = (markup.match(/<[^>]*>/g) ?? []).join('');
      expect(tags).not.toMatch(/<\/?(script|img|iframe|svg|math|dialog|object|embed|style|form|input|base|meta|link)\b/i);
      expect(tags).not.toMatch(/\son[a-z]+\s*=/i);
      expect(tags).not.toMatch(/(href|src)="\s*(javascript|data|vbscript):/i);
    }
  });
});
