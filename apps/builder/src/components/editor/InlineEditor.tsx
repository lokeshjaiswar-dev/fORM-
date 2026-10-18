import { useMemo } from 'react';
import { EditorContent } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { isEmptyLabel } from '@/lib/v1html';
import { FormatMenu } from '@/components/editor/FormatMenu';
import { useV1Editor, type V1EditorProps } from '@/components/editor/useV1Editor';
import type { EditorKind } from '@/components/editor/extensions';

export interface EditorFrameProps extends V1EditorProps {
  /** Grow to the row width; labels next to a required marker do not. */
  fill?: boolean;
  /** Classes for the editable element itself. */
  editorClassName?: string;
}

export function EditorFrame({ kind, fill = true, editorClassName, ...props }: EditorFrameProps & { kind: EditorKind }) {
  const editor = useV1Editor(kind, props, cn('min-h-[1em] w-full outline-none', editorClassName));
  const empty = useMemo(() => isEmptyLabel(props.value), [props.value]);
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

/** One-paragraph label editor (questions, headings, endings). Enter moves on; Shift+Enter breaks the line. */
export function InlineEditor(props: EditorFrameProps) {
  return <EditorFrame kind="inline" {...props} />;
}
