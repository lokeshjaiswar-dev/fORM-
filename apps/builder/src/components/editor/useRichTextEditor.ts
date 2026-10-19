import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { normalizeInlineDoc, normalizeRichDoc, type InlineDoc, type RichDoc } from '@form/schema';
import { editorExtensions, type EditorKind } from '@/components/editor/extensions';

/** What each editor kind edits: a one-paragraph label, or multi-block rich text. */
export type DocOf<K extends EditorKind> = K extends 'inline' ? InlineDoc : RichDoc;

export interface RichTextEditorProps<D extends InlineDoc | RichDoc> {
  /** The stored AST; the editor shows it and writes every change back as a normalized AST. */
  value: D;
  onChange: (doc: D) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}

/** The editor needs at least one block; an empty `RichDoc` opens as one empty paragraph. */
export const editorContent = (doc: InlineDoc | RichDoc): JSONContent => (doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] }) as JSONContent;

/** Editor JSON → canonical AST: the only way editor content reaches the store. */
export const editorAst = (kind: EditorKind, json: unknown): InlineDoc | RichDoc => (kind === 'inline' ? normalizeInlineDoc(json) : normalizeRichDoc(json));

const same = (a: InlineDoc | RichDoc, b: InlineDoc | RichDoc) => a === b || JSON.stringify(a) === JSON.stringify(b);

interface Callbacks { onChange: (doc: InlineDoc | RichDoc) => void; onEnter?: (() => void) | undefined }

/** Forwards editor events to the latest props without recreating the editor. */
function relay() {
  let current: Callbacks = { onChange: () => {} };
  return {
    set: (next: Callbacks) => {
      current = next;
    },
    change: (doc: InlineDoc | RichDoc) => current.onChange(doc),
    enter: () => current.onEnter?.(),
  };
}

export function useRichTextEditor(kind: EditorKind, { value, onChange, onEnter, autoFocus, placeholder }: RichTextEditorProps<InlineDoc | RichDoc>, editorClass: string): Editor | null {
  const stored = useRef(value);
  const [events] = useState(relay);
  useEffect(() => {
    events.set({ onChange, onEnter });
  });

  // TipTap compares options by identity on every render; only a changed class or label may reach setOptions.
  const [initial] = useState(() => ({ extensions: editorExtensions(kind, { onEnter: events.enter }), content: editorContent(value) }));
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
      const doc = editorAst(kind, e.getJSON());
      if (same(doc, stored.current)) return;
      stored.current = doc;
      events.change(doc);
    },
  });

  useEffect(() => {
    if (!editor || value === stored.current) return;
    stored.current = value;
    if (!same(editorAst(kind, editor.getJSON()), value)) editor.commands.setContent(editorContent(value), { emitUpdate: false });
  }, [editor, kind, value]);

  useEffect(() => {
    if (autoFocus && editor && !editor.isFocused) editor.commands.focus('end');
  }, [autoFocus, editor]);

  return editor;
}
