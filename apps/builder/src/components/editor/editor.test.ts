import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineDocSchema, RichDocSchema, fromHtml, fromHtmlInline, normalizeInlineDoc, normalizeRichDoc } from '@form/schema';
import { editorExtensions, type EditorKind } from '@/components/editor/extensions';
import { CLIPBOARD_TYPE, clipboardPayload } from '@/components/editor/paste';
import { editorAst, editorContent } from '@/components/editor/useRichTextEditor';
import { toHtml } from '@/lib/richHtml';
import { RICH_TEXT_FIXTURES } from '@/test/richtext-fixtures';
import { GOOGLE_DOCS, WORD } from '@form/schema/test-fixtures';

/* HTML is how these tests write and read documents compactly: in through the `fromHtml` allowlist, out through the clipboard serializer. */
const editorDoc = (kind: EditorKind, html: string) => editorContent(kind === 'inline' ? fromHtmlInline(html).doc : fromHtml(html).doc);
const editorHtml = (kind: EditorKind, json: unknown) => toHtml(editorAst(kind, json));

const editors: Editor[] = [];
function mount(kind: EditorKind, content: unknown, onEnter = () => {}) {
  const editor = new Editor({ extensions: editorExtensions(kind, { onEnter }), content: content as never });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

const normalize = (kind: EditorKind, json: unknown) => (kind === 'inline' ? normalizeInlineDoc(json) : normalizeRichDoc(json));

describe('editor ↔ AST round trip (50+ fixtures)', () => {
  it('has at least 50 fixtures with distinct names', () => {
    expect(RICH_TEXT_FIXTURES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(RICH_TEXT_FIXTURES.map((f) => f.name)).size).toBe(RICH_TEXT_FIXTURES.length);
  });

  it.each(RICH_TEXT_FIXTURES.map((f) => [f.name, f] as const))('%s', (_, { kind, doc }) => {
    expect((kind === 'inline' ? InlineDocSchema : RichDocSchema).safeParse(doc).success).toBe(true);
    expect(normalize(kind, doc)).toEqual(doc);

    const editor = mount(kind, editorContent(doc));
    const once = normalize(kind, editor.getJSON());
    expect(once).toEqual(doc);

    editor.commands.setContent(editorContent(once));
    expect(normalize(kind, editor.getJSON())).toEqual(doc);
  });
});

describe('AST ↔ clipboard HTML', () => {
  it.each(RICH_TEXT_FIXTURES.filter((f) => f.v1).map((f) => [f.name, f] as const))('%s', (_, { kind, doc }) => {
    const html = editorHtml(kind, doc);
    expect(normalize(kind, editorDoc(kind, html))).toEqual(doc);
    expect(editorHtml(kind, editorDoc(kind, html))).toBe(html);
  });

  it('reads labels from HTML through the allowlist only', () => {
    expect(editorHtml('inline', editorDoc('inline', 'Name <b>please</b>&nbsp;<span style="color: rgb(235, 87, 87);">now</span><br>'))).toBe(
      'Name <b>please</b> <span style="color: #eb5757">now</span>',
    );
    expect(editorHtml('inline', editorDoc('inline', '<img src=x onerror=alert(1)>Hi<script>alert(1)</script>'))).toBe('Hi');
    expect(editorHtml('rich', editorDoc('rich', 'a<div>b</div>'))).toBe('<p>a</p><p>b</p>');
  });
});

describe('editor behaviour', () => {
  function key(editor: Editor, init: KeyboardEventInit) {
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  }

  it('Enter in a label calls onEnter and never splits it; Shift+Enter adds a break', () => {
    const onEnter = vi.fn();
    const editor = mount('inline', editorDoc('inline', 'ab'), onEnter);
    editor.commands.setTextSelection(2);
    key(editor, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
    key(editor, { key: 'Enter', shiftKey: true });
    expect(editor.getJSON().content).toHaveLength(1);
    expect(editorHtml('inline', editor.getJSON())).toBe('a<br>b');
  });

  it('Enter in rich text starts a paragraph; Enter on an empty last one moves on', () => {
    const onEnter = vi.fn();
    const editor = mount('rich', editorDoc('rich', 'ab'), onEnter);
    editor.commands.focus('end');
    key(editor, { key: 'Enter' });
    expect(onEnter).not.toHaveBeenCalled();
    expect(editor.getJSON().content).toHaveLength(2);
    key(editor, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
    expect(editor.getJSON().content).toHaveLength(1);
  });

  it('links only accept safe targets', () => {
    const editor = mount('inline', editorDoc('inline', 'x'));
    editor.chain().selectAll().setLink({ href: 'javascript:alert(1)' }).run();
    expect(editorHtml('inline', editor.getJSON())).toBe('x');
    editor.chain().selectAll().setLink({ href: 'https://ok.example' }).run();
    expect(editorHtml('inline', editor.getJSON())).toBe('<a href="https://ok.example">x</a>');
  });

  it('renders links, colours and atoms without event handlers', () => {
    const editor = mount('rich', editorContent(RICH_TEXT_FIXTURES.find((f) => f.name === 'mixed document')!.doc));
    const html = editor.view.dom.outerHTML;
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('paste filtering', () => {
  function paste(editor: Editor, data: Record<string, string>) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '' } });
    editor.view.dom.dispatchEvent(event);
    return event;
  }

  it('Google Docs into rich text keeps bold, italic, underline, links and lists only', () => {
    const editor = mount('rich', editorDoc('rich', ''));
    expect(paste(editor, { 'text/html': GOOGLE_DOCS }).defaultPrevented).toBe(true);
    const html = editorHtml('rich', editor.getJSON());
    expect(html).toBe([
      '<p>Event registration</p>',
      '<p>Plain, <b>bold</b>, <i>italic</i>, <u>underlined</u>, struck in red and a <u><a href="https://example.com/terms">link</a></u>.</p>',
      '<ul><li>First</li><li><b>Second</b></li></ul><ol><li>One</li></ol>',
    ].join(''));
  });

  it('Word into a label keeps the allowed marks on one line', () => {
    const editor = mount('inline', editorDoc('inline', ''));
    paste(editor, { 'text/html': WORD });
    const html = editorHtml('inline', editor.getJSON());
    expect(html).toMatch(/^Heading in Word<br><b>Bold red<\/b> then <i>italic<\/i> and <u>under<\/u><br>Bullet one<br>Nested <b>bullet<\/b>/);
    expect(html).not.toMatch(/style=|<span|<s>|mso/);
  });

  it('plain text pastes as text, never as markup', () => {
    const editor = mount('inline', editorDoc('inline', ''));
    paste(editor, { 'text/plain': '<img src=x onerror=alert(1)>' });
    expect(editorHtml('inline', editor.getJSON())).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('hostile HTML pastes as its text', () => {
    const editor = mount('rich', editorDoc('rich', ''));
    paste(editor, { 'text/html': '<b onclick="alert(1)">x</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">y</a><span style="color:red">z</span>' });
    expect(editorHtml('rich', editor.getJSON())).toBe('<b>x</b>yz');
  });
});

describe('builder clipboard (copy and paste between builder editors)', () => {
  function clipboardEvent(editor: Editor, type: 'copy' | 'cut' | 'paste', store: Map<string, string>) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const clipboardData = {
      getData: (t: string) => store.get(t) ?? '',
      setData: (t: string, v: string) => store.set(t, v),
      clearData: () => store.clear(),
    };
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    editor.view.dom.dispatchEvent(event);
    return event;
  }
  const formatted = (name: string) => RICH_TEXT_FIXTURES.find((f) => f.name === name)!.doc;

  it('keeps every allowed mark and block that the strict paste rules would drop', () => {
    const doc = normalizeRichDoc({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'red', marks: [{ type: 'strike' }, { type: 'textColor', attrs: { color: '#eb5757' } }] },
          { type: 'text', text: ' code', marks: [{ type: 'code' }] },
        ] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }] },
      ],
    });
    const source = mount('rich', editorContent(doc));
    const store = new Map<string, string>();
    source.commands.selectAll();
    expect(clipboardEvent(source, 'copy', store).defaultPrevented).toBe(true);
    expect([...store.keys()].sort()).toEqual([CLIPBOARD_TYPE, 'text/html', 'text/plain'].sort());
    expect(store.get('text/plain')).toBe('Title\nred code\n> quote');
    expect(store.get('text/html')).not.toMatch(/\son[a-z]+=/i);

    const target = mount('rich', editorDoc('rich', ''));
    clipboardEvent(target, 'paste', store);
    expect(normalizeRichDoc(target.getJSON())).toEqual(doc);

    store.delete(CLIPBOARD_TYPE);
    const external = mount('rich', editorDoc('rich', ''));
    clipboardEvent(external, 'paste', store);
    expect(editorHtml('rich', external.getJSON())).toBe('<p>Title</p><p>red code</p><p>quote</p>');
  });

  it('round-trips the formatted fixtures and pastes a label into a label inline', () => {
    const doc = formatted('mixed document');
    const source = mount('rich', editorContent(doc));
    const store = new Map<string, string>();
    source.commands.selectAll();
    clipboardEvent(source, 'copy', store);
    const target = mount('rich', editorDoc('rich', ''));
    clipboardEvent(target, 'paste', store);
    expect(normalizeRichDoc(target.getJSON())).toEqual(doc);

    const label = mount('inline', editorDoc('inline', 'Name <s>old</s> <span style="color: #eb5757">red</span>'));
    const labelStore = new Map<string, string>();
    label.commands.selectAll();
    clipboardEvent(label, 'copy', labelStore);
    const other = mount('inline', editorDoc('inline', 'Hi:'));
    other.commands.focus('end');
    clipboardEvent(other, 'paste', labelStore);
    expect(editorHtml('inline', other.getJSON())).toBe('Hi:Name <s>old</s> <span style="color: #eb5757">red</span>');
  });

  it('BL-063: a copy of unsafe editor JSON puts nothing unsafe in any of the three clipboard entries', () => {
    const unsafe = [
      { type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [
        { type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', onmouseover: 'alert(2)' } }] },
        { type: 'text', text: '<img src=x onerror=alert(3)>' },
        { type: 'script', content: [{ type: 'text', text: 'alert(4)' }] },
      ] },
      { type: 'iframe', attrs: { src: 'https://evil.example' } },
    ];
    const payload = clipboardPayload(unsafe);
    expect(payload.html).not.toMatch(/<[^>]*\son[a-z]+\s*=|javascript:|<img|<script|<iframe/i);
    expect(payload.internal).not.toMatch(/"on[a-z]+"\s*:|javascript:|"(script|iframe)"/i);
    expect(payload.html).toBe('bad&lt;img src=x onerror=alert(3)&gt;');
    expect(payload.text).toBe('bad<img src=x onerror=alert(3)>');
    expect(JSON.parse(payload.internal).doc).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad<img src=x onerror=alert(3)>' }] }] });
  });

  it('BL-053: clipboard HTML keeps an empty first paragraph in a list item and line breaks inside text', () => {
    const list = normalizeRichDoc({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] }] }] }] }] });
    expect(toHtml(list)).toBe('<ul><li><p><br></p><ul><li>inner</li></ul></li></ul>');
    expect(toHtml({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' + String.fromCharCode(10) + 'two' }] }] })).toBe('one<br>two');
  });

  it('cut removes the selection', () => {
    const editor = mount('inline', editorDoc('inline', 'abc'));
    const store = new Map<string, string>();
    editor.commands.setTextSelection({ from: 2, to: 3 });
    clipboardEvent(editor, 'cut', store);
    expect(editorHtml('inline', editor.getJSON())).toBe('ac');
    expect(store.get('text/plain')).toBe('b');
  });

  it('a forged builder payload is still normalized, and a broken one falls back to the strict rules', () => {
    const forged = JSON.stringify({
      format: 'fORM-rich-text',
      version: 1,
      doc: { type: 'doc', content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold' }] },
          { type: 'html', content: '<img src=x onerror=alert(1)>' },
        ] },
        { type: 'image', attrs: { asset: { url: 'https://evil.example/x.png' } } },
      ] },
    });
    const editor = mount('rich', editorDoc('rich', ''));
    clipboardEvent(editor, 'paste', new Map([[CLIPBOARD_TYPE, forged]]));
    expect(editorHtml('rich', editor.getJSON())).toBe('<b>x</b>');

    for (const broken of ['{', JSON.stringify({ format: 'other', version: 1, doc: {} }), JSON.stringify({ format: 'fORM-rich-text', version: 2, doc: {} })]) {
      const fallback = mount('rich', editorDoc('rich', ''));
      clipboardEvent(fallback, 'paste', new Map([[CLIPBOARD_TYPE, broken], ['text/html', '<s>struck</s> <b>bold</b>']]));
      expect(editorHtml('rich', fallback.getJSON())).toBe('struck <b>bold</b>');
    }
  });
});
