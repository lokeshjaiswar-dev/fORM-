import { EditorFrame, type EditorFrameProps } from '@/components/editor/InlineEditor';

/** Multi-block rich text (paragraph blocks). Enter on an empty last line or Mod+Enter moves on. */
export function RichEditor(props: EditorFrameProps) {
  return <EditorFrame kind="rich" {...props} />;
}
