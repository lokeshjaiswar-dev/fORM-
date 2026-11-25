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
  /**
   * With `fill` off: be exactly as wide as the text, so a marker placed after the editor (the required asterisk)
   * sits right after the last word. Only an empty editor keeps a minimum width, to show its placeholder.
   */
  hug?: boolean;
  /** Classes for the editable element itself. */
  editorClassName?: string;
  /** Classes for the frame around the editor (its click area). */
  frameClassName?: string;
}

export type InlineEditorProps = RichTextEditorProps<InlineDoc> & FrameOptions;
export type RichEditorProps = RichTextEditorProps<RichDoc> & FrameOptions;

/** Nothing to show: only empty paragraphs. */
const isEmpty = (doc: InlineDoc | RichDoc) => doc.content.every((node) => node.type === 'paragraph') && !toPlain(doc).trim();

export function EditorFrame({ kind, fill = true, hug = false, editorClassName, frameClassName, ...props }: RichTextEditorProps<InlineDoc | RichDoc> & FrameOptions & { kind: EditorKind }) {
  const editor = useRichTextEditor(kind, props, cn('min-h-[1em] w-full outline-none', editorClassName));
  const empty = useMemo(() => isEmpty(props.value), [props.value]);
  const minWidth = hug && !fill && !empty ? 'min-w-[1ch]' : 'min-w-40';
  return (
    <>
      <div
        className={cn('relative flex min-h-8 items-center', fill ? 'min-w-0 flex-1' : cn(minWidth, 'max-w-[calc(100%-1.25rem)]'), frameClassName)}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            editor?.commands.focus('end');
          }
        }}
      >
        {/* The placeholder takes the editor's own type and padding, so an empty heading still reads as a heading. */}
        {empty ? (
          <div className={cn(props.className, 'pointer-events-none absolute inset-0 flex items-center whitespace-nowrap text-[#c5c4c1]')} style={props.style}>
            {props.placeholder}
          </div>
        ) : null}
        <EditorContent editor={editor} className={cn(minWidth, !hug && 'pe-0.5', fill && 'w-full', props.className)} style={props.style} />
      </div>
      {editor ? <FormatMenu editor={editor} /> : null}
    </>
  );
}

/** One-paragraph label editor (questions, headings). Enter moves on; Shift+Enter breaks the line. */
export function InlineEditor(props: InlineEditorProps) {
  return <EditorFrame kind="inline" {...(props as RichTextEditorProps<InlineDoc | RichDoc> & FrameOptions)} />;
}
