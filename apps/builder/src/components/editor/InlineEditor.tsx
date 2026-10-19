import { useMemo } from 'react';
import { EditorContent } from '@tiptap/react';
import { toPlain, type InlineDoc, type RichDoc } from '@form/schema';
import { cn } from '@/lib/utils';
import { FormatMenu } from '@/components/editor/FormatMenu';
import { useRichTextEditor, type RichTextEditorProps } from '@/components/editor/useRichTextEditor';
import type { EditorKind } from '@/components/editor/extensions';

interface FrameOptions {
  /** Grow to the row width; labels next to a required marker do not. */
  fill?: boolean;
  /** Classes for the editable element itself. */
  editorClassName?: string;
}

export type InlineEditorProps = RichTextEditorProps<InlineDoc> & FrameOptions;
export type RichEditorProps = RichTextEditorProps<RichDoc> & FrameOptions;

/** Nothing to show: only empty paragraphs. */
const isEmpty = (doc: InlineDoc | RichDoc) => doc.content.every((node) => node.type === 'paragraph') && !toPlain(doc).trim();

export function EditorFrame({ kind, fill = true, editorClassName, ...props }: RichTextEditorProps<InlineDoc | RichDoc> & FrameOptions & { kind: EditorKind }) {
  const editor = useRichTextEditor(kind, props, cn('min-h-[1em] w-full outline-none', editorClassName));
  const empty = useMemo(() => isEmpty(props.value), [props.value]);
  return (
    <>
      <div className={cn('relative flex min-h-8 min-w-0 items-center', fill ? 'flex-1' : 'max-w-[calc(100%-1.25rem)]')}>
        {empty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center whitespace-nowrap text-[#c5c4c1]" style={props.style}>
            {props.placeholder}
          </div>
        ) : null}
        <EditorContent editor={editor} className={cn('min-w-0', fill && 'w-full', props.className)} style={props.style} />
      </div>
      {editor ? <FormatMenu editor={editor} /> : null}
    </>
  );
}

/** One-paragraph label editor (questions, headings). Enter moves on; Shift+Enter breaks the line. */
export function InlineEditor(props: InlineEditorProps) {
  return <EditorFrame kind="inline" {...(props as RichTextEditorProps<InlineDoc | RichDoc> & FrameOptions)} />;
}
