import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import type { InlineNode, Mark, ParagraphNode, RichBlockNode, RichDoc } from '../src/index.ts';
import { valid } from './arbitrary.ts';
import { GOOGLE_DOCS, WORD } from './fixtures/paste.ts';
import { DEEP_NESTING, XSS_PAYLOADS } from './fixtures/xss.ts';

const text = (t: string, ...marks: Mark[]): InlineNode => (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const p = (...content: InlineNode[]): ParagraphNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const doc = (...content: RichBlockNode[]): RichDoc => ({ type: 'doc', content });
const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };
const underline: Mark = { type: 'underline' };
const link = (href: string): Mark => ({ type: 'link', attrs: { href: href as S.SafeHref } });
const color = (c: string): Mark => ({ type: 'textColor', attrs: { color: c as S.HexColor } });

function marksIn(d: RichDoc): Mark[] {
  const out: Mark[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as { marks?: Mark[]; content?: unknown[] };
    out.push(...(n.marks ?? []));
    for (const child of n.content ?? []) walk(child);
  };
  walk(d);
  return out;
}

const nodeTypes = (d: unknown): Set<string> => {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as { type?: string; content?: unknown[] };
    if (n.type) out.add(n.type);
    for (const child of n.content ?? []) walk(child);
  };
  walk(d);
  return out;
};

describe('XSS corpus', () => {
  it('has at least 150 payloads', () => {
    expect(new Set(XSS_PAYLOADS).size).toBeGreaterThanOrEqual(150);
  });

  it.each(XSS_PAYLOADS.map((payload, i) => [i, payload] as const))('payload %i converts to a valid AST with only safe links', (_, payload) => {
    const { doc: rich } = S.fromHtml(payload);
    expect(S.RichDocSchema.safeParse(rich).success).toBe(true);
    const { doc: inline } = S.fromHtmlInline(payload);
    expect(S.InlineDocSchema.safeParse(inline).success).toBe(true);
    for (const mark of [...marksIn(rich), ...marksIn(inline)]) {
      if (mark.type === 'link') expect(mark.attrs.href).toMatch(/^(https?:\/\/[a-z0-9.-]+[/?#]?|mailto:|tel:)/i);
    }
    const json = JSON.stringify(rich);
    expect(json).not.toMatch(/"(on[a-z]+|src|style|srcdoc|formaction)"/i);
    for (const type of nodeTypes(rich)) expect(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'horizontalRule', 'text', 'hardBreak']).toContain(type);
  });

  it('notes what it removed', () => {
    expect(S.fromHtml('<img src=x onerror=alert(1)><script>x</script><a href="javascript:x">a</a>').dropped).toEqual(
      expect.arrayContaining(['<img>', 'onerror', 'src', '<script>', 'href']),
    );
    expect(S.fromHtml('<b>plain</b> <span style="color:red">text</span>').dropped).toEqual([]);
  });

  it('drops script, style and template content but keeps unknown elements\' text', () => {
    expect(S.toPlain(S.fromHtml('<script>alert(1)</script><style>p{}</style><template>t</template><x-y>kept</x-y>').doc)).toBe('kept');
  });
});

describe('fromHtml: v1 builder HTML', () => {
  it('maps the v1 toolbar formatting to marks', () => {
    const { doc: d } = S.fromHtmlInline(
      '<b>b</b><i>i</i><u>u</u><s>s</s> <span style="color: rgb(235, 87, 87);">red</span> <span style="background-color: rgb(253, 236, 200);">hi</span> <font color="#337EA9">blue</font>',
    );
    expect(d.content[0].content).toEqual([
      text('b', bold), text('i', italic), text('u', underline), text('s', { type: 'strike' }), text(' '),
      text('red', color('#eb5757')), text(' '), text('hi', { type: 'highlight', attrs: { color: '#fdecc8' as S.HexColor } }),
      text(' '), text('blue', color('#337ea9')),
    ]);
  });

  it('keeps only safe link targets and never stores rel or target', () => {
    const { doc: d } = S.fromHtmlInline('<a href=" https://a.example/x " rel="noopener" target="_blank">ok</a><a href="javascript:alert(1)">bad</a><a href="mailto:a@b.co">m</a><a href="tel:+91 98765 43210">t</a>');
    expect(d.content[0].content).toEqual([
      text('ok', link('https://a.example/x')), text('bad'), text('m', link('mailto:a@b.co')), text('t', link('tel:+91 98765 43210')),
    ]);
  });

  it('turns divs and paragraphs into blocks and br into hard breaks; trailing breaks vanish', () => {
    expect(S.fromHtml('first<div>second<br>line</div><div><br></div><p>third<br></p>').doc).toEqual(doc(
      p(text('first')), p(text('second'), { type: 'hardBreak' }, text('line')), p(), p(text('third')),
    ));
    expect(S.fromHtmlInline('a<div>b</div>').doc.content[0].content).toEqual([text('a'), { type: 'hardBreak' }, text('b')]);
  });

  it('collapses HTML whitespace but keeps no-break spaces and pre text', () => {
    expect(S.fromHtml('<p>\n  a   <b> b </b>  c&nbsp;&nbsp;d \n</p>').doc).toEqual(doc(p(text('a '), text('b ', bold), text('c  d'))));
    expect(S.fromHtml('<pre>x  y\nz</pre>').doc).toEqual(doc(p(text('x  y'), { type: 'hardBreak' }, text('z'))));
  });

  it('decodes entities into text, so markup in text stays text', () => {
    expect(S.toPlain(S.fromHtml('&lt;img src=x onerror=alert(1)&gt; &amp; co').doc)).toBe('<img src=x onerror=alert(1)> & co');
  });

  it('maps headings, lists, quotes and rules, clamping heading levels to 3', () => {
    expect(S.fromHtml('<h1 style="text-align:center">T</h1><h5>five</h5><ol start="3"><li>a<ul><li>b</li></ul></li></ol><blockquote><p>q</p></blockquote><hr>').doc).toEqual(doc(
      { type: 'heading', attrs: { level: 1, align: 'center' }, content: [text('T')] },
      { type: 'heading', attrs: { level: 3 }, content: [text('five')] },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(text('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('b'))] }] }] }] },
      { type: 'blockquote', content: [p(text('q'))] },
      { type: 'horizontalRule' },
    ));
  });

  it('flattens lists nested deeper than 3 and quotes inside quotes', () => {
    const { doc: d } = S.fromHtml(`${'<ul><li>x'.repeat(6)}${'</li></ul>'.repeat(6)}<blockquote><blockquote>in</blockquote></blockquote>`);
    expect(S.RichDocSchema.safeParse(d).success).toBe(true);
    expect(S.toPlain(d)).toContain('x');
    expect(d.content.at(-1)).toEqual({ type: 'blockquote', content: [p(text('in'))] });
  });

  it('font-weight and text-decoration styles override tags', () => {
    expect(S.fromHtmlInline('<b style="font-weight:normal">n<span style="font-weight:700">y</span></b><span style="text-decoration: underline line-through">u</span>').doc.content[0].content).toEqual([
      text('n'), text('y', bold), text('u', underline, { type: 'strike' }),
    ]);
  });

  it('caps the node count of hostile input', () => {
    const { doc: d, dropped } = S.fromHtml('<p>x</p>'.repeat(25_000));
    expect(S.RichDocSchema.safeParse(d).success).toBe(true);
    expect(dropped).toContain('content beyond the node limit');
  });

  it.each<readonly [string, string]>([
    ['deep lists with text', '<ul><li>x'.repeat(10_000)],
    ['deep bare lists', `${'<ul>'.repeat(10_000)}x`],
    ['deep quotes', `${'<blockquote>'.repeat(15_000)}x`],
    ['deep lists in quotes', '<blockquote><ol><li>x'.repeat(5_000)],
    ...DEEP_NESTING.map((html, i) => [`corpus entry ${i}`, html] as const),
  ])('reads %s without recursing per level', (_, html) => {
    const { doc: d } = S.fromHtml(html);
    expect(S.RichDocSchema.safeParse(d).success).toBe(true);
    expect(S.measureRichText(d).listDepth).toBeLessThanOrEqual(3);
    expect(S.toPlain(d)).toMatch(/x|deep/);
    expect(S.InlineDocSchema.safeParse(S.fromHtmlInline(html).doc).success).toBe(true);
    expect(S.htmlToPlain(html)).toMatch(/x|deep/);
  });

  it('stays linear in nesting depth', () => {
    const time = (n: number) => {
      const html = `${'<b>'.repeat(n)}${'x<br>'.repeat(n / 4)}`;
      const started = performance.now();
      S.fromHtml(html);
      return performance.now() - started;
    };
    time(1_000);
    const small = time(5_000);
    const large = time(20_000);
    /* 4x the input: linear work is about 4x the time, quadratic work 16x. */
    expect(large).toBeLessThan(10 * Math.max(small, 50));
  });

  it('truncates rather than empties at the node limit', () => {
    const { doc: d, dropped } = S.fromHtml(`${'<b>'.repeat(20_000)}${'x<br>'.repeat(10_000)}`);
    expect(S.RichDocSchema.safeParse(d).success).toBe(true);
    expect(dropped).toContain('content beyond the node limit');
    const run = d.content[0]?.type === 'paragraph' ? d.content[0].content ?? [] : [];
    expect(run.length).toBeGreaterThan(19_000);
    expect(run[0]).toEqual(text('x', bold));
  });

  it('counts the lines of pre text against the node limit', () => {
    const { doc: d } = S.fromHtml(`<pre>${'a\n'.repeat(30_000)}</pre>`);
    expect(S.RichDocSchema.safeParse(d).success).toBe(true);
  });

  it('htmlToInline and htmlToPlain implement the MigrationContext helpers', () => {
    expect(S.htmlToInline('<b>Name</b><br>please')).toEqual([text('Name', bold), { type: 'hardBreak' }, text('please')]);
    expect(S.htmlToPlain('<p>a</p><ul><li>b</li></ul>')).toBe('a\n- b');
  });
});

describe('paste filtering', () => {
  it('Google Docs keeps bold, italic, underline, links and lists only', () => {
    const { doc: d } = S.fromHtml(GOOGLE_DOCS, S.PASTE_PROFILE);
    expect(d).toEqual(doc(
      p(text('Event registration')),
      p(text('Plain, '), text('bold', bold), text(', '), text('italic', italic), text(', '), text('underlined', underline), text(', struck in red and a '), text('link', underline, link('https://example.com/terms')), text('.')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('First'))] }, { type: 'listItem', content: [p(text('Second', bold))] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [p(text('One'))] }] },
    ));
  });

  it('Word keeps the same, and rebuilds its paragraph lists', () => {
    const { doc: d } = S.fromHtml(WORD, S.PASTE_PROFILE);
    expect(d).toEqual(doc(
      p(text('Heading in Word')),
      p(text('Bold red', bold), text(' then '), text('italic', italic), text(' and '), text('under', underline)),
      { type: 'bulletList', content: [
        { type: 'listItem', content: [p(text('Bullet one')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('Nested '), text('bullet', bold))] }] }] },
        { type: 'listItem', content: [p(text('Bullet two'))] },
      ] },
      { type: 'orderedList', content: [
        { type: 'listItem', content: [p(text('Step one'))] },
        { type: 'listItem', content: [p(text('Step two with '), text('a link', link('https://example.org/')))] },
      ] },
      p(text('Highlighted struck')),
    ));
  });

  it('every mark left after a paste is in the paste profile', () => {
    for (const html of [GOOGLE_DOCS, WORD, ...XSS_PAYLOADS]) {
      for (const mark of marksIn(S.fromHtml(html, S.PASTE_PROFILE).doc)) expect(S.PASTE_PROFILE.marks).toContain(mark.type);
    }
  });

  it('the full profile keeps Word colours and highlights', () => {
    const marks = marksIn(S.fromHtml(WORD).doc);
    expect(marks).toContainEqual(color('#c00000'));
    expect(marks).toContainEqual({ type: 'highlight', attrs: { color: '#ffff00' } });
  });
});

describe('normalize', () => {
  it('cleans editor JSON: null attrs, extra link attrs, mark order, adjacent text', () => {
    const editor = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { align: null }, content: [
          { type: 'text', text: 'a', marks: [{ type: 'italic' }, { type: 'bold' }] },
          { type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'text', text: 'c', marks: [{ type: 'link', attrs: { href: 'https://x.example', target: '_blank', rel: 'noopener', class: null } }] },
          { type: 'text', text: 'd', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'textColor', attrs: { color: { token: 'accent' } } }] },
          { type: 'text', text: '', marks: [] },
          { type: 'hardBreak' },
        ] },
        { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'unwrapped' }] },
        { type: 'paragraph', attrs: { align: null } },
      ],
    };
    expect(S.normalizeRichDoc(editor)).toEqual(doc(
      p(text('ab', bold, italic), text('c', link('https://x.example')), text('d', { type: 'textColor', attrs: { color: { token: 'accent' } } })),
      { type: 'orderedList', content: [{ type: 'listItem', content: [p()] }] },
      p(text('unwrapped')),
    ));
  });

  it('validates pipe and var atoms and drops broken ones', () => {
    const out = S.normalizeInlineDoc({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'b1' }, format: null, fallback: 'there', encode: null } },
      { type: 'pipe', attrs: { source: { kind: 'nope' } } },
      { type: 'var', attrs: { name: 'org.legal_name', fallback: null } },
      { type: 'var', attrs: { name: 'Not A Var' } },
    ] }] });
    expect(out.content[0].content).toEqual([
      { type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'b1' }, fallback: 'there' } },
      { type: 'var', attrs: { name: 'org.legal_name' } },
    ]);
    expect(S.normalizeInlineDoc(out, S.PASTE_PROFILE).content[0]).toEqual({ type: 'paragraph' });
  });

  it('makes an inline doc out of several blocks', () => {
    expect(S.normalizeInlineDoc(doc(p(), { type: 'heading', attrs: { level: 2, align: 'right' }, content: [text('h')] }, p(text('x')), p()))).toEqual({
      type: 'doc', content: [{ type: 'paragraph', attrs: { align: 'right' }, content: [text('h'), { type: 'hardBreak' }, text('x')] }],
    });
  });

  it('is idempotent and always schema-valid', () => {
    fc.assert(fc.property(valid(S.RichDocSchema), (d) => {
      const once = S.normalizeRichDoc(d);
      expect(S.RichDocSchema.safeParse(once).success).toBe(true);
      expect(S.normalizeRichDoc(once)).toEqual(once);
      const inline = S.normalizeInlineDoc(d);
      expect(S.InlineDocSchema.safeParse(inline).success).toBe(true);
      expect(S.normalizeInlineDoc(inline)).toEqual(inline);
    }), { numRuns: 300 });
  }, 60_000);
});

describe('normalize: nesting', () => {
  const nest = (type: string, depth: number, leaf: unknown): unknown => {
    let node = leaf;
    for (let i = 0; i < depth; i++) node = { type, content: type === 'bulletList' ? [{ type: 'listItem', content: [node] }] : [node] };
    return node;
  };

  it.each(['bulletList', 'blockquote', 'x-wrapper'])('flattens %s nested 10k deep without recursing per level', (type) => {
    const input = { type: 'doc', content: [nest(type, 10_000, { type: 'paragraph', content: [text('deep')] }), p(text('after'))] };
    const rich = S.normalizeRichDoc(input);
    expect(S.RichDocSchema.safeParse(rich).success).toBe(true);
    expect(S.toPlain(rich)).toMatch(/deep[\s\S]*after/);
    const inline = S.normalizeInlineDoc(input);
    expect(S.InlineDocSchema.safeParse(inline).success).toBe(true);
    expect(S.toPlain(inline)).toBe('deep\nafter');
  });
});

describe('normalize: node limit', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => p(text(`line ${i}`)));

  it('cuts editor JSON with more than maxNodes nodes at one point', () => {
    const rich = S.normalizeRichDoc(doc(...lines(25_000)));
    expect(S.RichDocSchema.safeParse(rich).success).toBe(true);
    expect(S.measureRichText(rich).nodes).toBe(S.RICH_TEXT_LIMITS.maxNodes);
    expect(rich.content[0]).toEqual(p(text('line 0')));
    expect(rich.content.at(-1)).toEqual(p(text(`line ${S.RICH_TEXT_LIMITS.maxNodes / 2 - 1}`)));
  });

  it('drops a list the cut leaves empty and trims a cut paragraph to its last content', () => {
    const items = Array.from({ length: 12_000 }, (_, i) => ({ type: 'listItem', content: [p(text(`item ${i}`))] }));
    const rich = S.normalizeRichDoc({ type: 'doc', content: [{ type: 'bulletList', content: items }, { type: 'bulletList', content: items }] });
    expect(S.RichDocSchema.safeParse(rich).success).toBe(true);
    expect(rich.content).toHaveLength(1);

    const run = Array.from({ length: 30_000 }, (_, i) => (i % 2 ? text(`w${i}`, i % 4 === 1 ? bold : italic) : { type: 'hardBreak' }));
    const inline = S.normalizeInlineDoc({ type: 'doc', content: [{ type: 'paragraph', content: run }] });
    expect(S.InlineDocSchema.safeParse(inline).success).toBe(true);
    expect(S.measureRichText(inline).nodes).toBeLessThanOrEqual(S.RICH_TEXT_LIMITS.maxNodes);
    expect(inline.content[0].content?.at(-1)?.type).toBe('text');
  });
});

describe('toPlain', () => {
  it('renders blocks, lists, quotes and atoms as text', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
      { type: 'orderedList', attrs: { start: 2 }, content: [{ type: 'listItem', content: [p(text('two')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('sub'))] }] }] }] },
      { type: 'blockquote', content: [p(text('q'), { type: 'hardBreak' }, text('r'))] },
      { type: 'horizontalRule' },
      p(text('Hi '), { type: 'pipe', attrs: { source: { kind: 'answer', blockId: 'b' as S.BlockId }, fallback: 'friend' } }, text(' from '), { type: 'var', attrs: { name: 'org.name' } }),
    );
    expect(S.toPlain(d)).toBe('Title\n2. two\n   - sub\n> q\n> r\n---\nHi friend from {org.name}');
    expect(S.toPlain(d, { pipe: () => 'Asha', var: () => 'Acme' }).split('\n').at(-1)).toBe('Hi Asha from Acme');
  });
});

describe('parseCssColor', () => {
  it.each([
    ['#ABC', '#aabbcc'], ['#aabbccff', '#aabbcc'], ['#aabbcc80', '#aabbcc80'], ['rgb(235, 87, 87)', '#eb5757'],
    ['rgba(0,0,0,0.5)', '#00000080'], ['rgb(100% 0% 0%)', '#ff0000'], ['Red', '#ff0000'], ['var(--fr-accentText)', { token: 'accentText' }],
  ])('%s', (input, expected) => expect(S.parseCssColor(input)).toEqual(expected));

  it.each(['transparent', 'rgba(1,2,3,0)', '#0000'])('%s is clear', (input) => expect(S.parseCssColor(input)).toBeNull());

  it.each(['url(javascript:alert(1))', 'expression(alert(1))', 'var(--x)', 'var(--fr-nope)', 'constructor', '__proto__', 'calc(1px)', 'rgb(1,2)'])('%s is rejected', (input) => {
    expect(S.parseCssColor(input)).toBeUndefined();
  });
});
