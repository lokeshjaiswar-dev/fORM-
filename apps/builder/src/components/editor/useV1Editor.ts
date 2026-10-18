import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { normalizeInlineDoc, normalizeRichDoc, type InlineDoc, type RichDoc } from '@form/schema';
import { editorExtensions, type EditorKind } from '@/components/editor/extensions';
import { labelDoc, richDoc, toV1Html } from '@/lib/v1html';

export interface V1EditorProps {
  /** v1 label HTML from the store; read only through the `fromHtml` allowlist. */
  value: string;
  onChange: (html: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}

/** The editor needs at least one block; an empty `RichDoc` opens as one empty paragraph. */
export const editorContent = (doc: InlineDoc | RichDoc): JSONContent => (doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] }) as JSONContent;

export const editorDoc = (kind: EditorKind, html: string): JSONContent => editorContent(kind === 'inline' ? labelDoc(html) : richDoc(html));

/** Editor JSON → canonical AST → v1 HTML: the only way editor content reaches the store. */
export const editorHtml = (kind: EditorKind, json: unknown): string =>
  toV1Html(kind === 'inline' ? normalizeInlineDoc(json) : normalizeRichDoc(json));

interface Callbacks { onChange: (html: string) => void; onEnter?: (() => void) | undefined }

/** Forwards editor events to the latest props without recreating the editor. */
function relay() {
  let current: Callbacks = { onChange: () => {} };
  return {
    set: (next: Callbacks) => {
      current = next;
    },
    change: (html: string) => current.onChange(html),
    enter: () => current.onEnter?.(),
  };
}

export function useV1Editor(kind: EditorKind, { value, onChange, onEnter, autoFocus, placeholder }: V1EditorProps, editorClass: string): Editor | null {
  const stored = useRef(value);
  const [events] = useState(relay);
  useEffect(() => {
    events.set({ onChange, onEnter });
  });

  // TipTap compares options by identity on every render; only a changed class or label may reach setOptions.
  const [initial] = useState(() => ({ extensions: editorExtensions(kind, { onEnter: events.enter }), content: editorDoc(kind, value) }));
  const editorProps = useMemo(() => ({
    attributes: {
      class: editorClass,
      role: 'textbox',
      'aria-label': placeholder ?? '',
      ...(kind === 'rich' ? { 'aria-multiline': 'true' } : {}),
    },
  }), [editorClass, kind, placeholder]);

  const editor = useEditor({
    ...initial,
    shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor: e }) => {
      const html = editorHtml(kind, e.getJSON());
      if (html === stored.current) return;
      stored.current = html;
      events.change(html);
    },
  });

  useEffect(() => {
    if (!editor || value === stored.current) return;
    stored.current = value;
    if (editorHtml(kind, editor.getJSON()) !== value) editor.commands.setContent(editorDoc(kind, value), { emitUpdate: false });
  }, [editor, kind, value]);

  useEffect(() => {
    if (autoFocus && editor && !editor.isFocused) editor.commands.focus('end');
  }, [autoFocus, editor]);

  return editor;
}
