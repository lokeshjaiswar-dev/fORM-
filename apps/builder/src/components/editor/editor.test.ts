import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineDocSchema, RichDocSchema, normalizeInlineDoc, normalizeRichDoc } from '@form/schema';
import { editorExtensions, type EditorKind } from '@/components/editor/extensions';
import { editorContent, editorDoc, editorHtml } from '@/components/editor/useV1Editor';
import { RICH_TEXT_FIXTURES } from '@/test/richtext-fixtures';
import { GOOGLE_DOCS, WORD } from '@form/schema/test-fixtures';

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

describe('AST ↔ v1 HTML boundary', () => {
  it.each(RICH_TEXT_FIXTURES.filter((f) => f.v1).map((f) => [f.name, f] as const))('%s', (_, { kind, doc }) => {
    const html = editorHtml(kind, doc);
    expect(normalize(kind, editorDoc(kind, html))).toEqual(doc);
    expect(editorHtml(kind, editorDoc(kind, html))).toBe(html);
  });

  it('reads legacy v1 labels', () => {
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
