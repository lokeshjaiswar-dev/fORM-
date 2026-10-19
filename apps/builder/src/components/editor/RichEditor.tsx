import type { InlineDoc, RichDoc } from '@form/schema';
import { EditorFrame, type RichEditorProps } from '@/components/editor/InlineEditor';
import type { RichTextEditorProps } from '@/components/editor/useRichTextEditor';

/** Multi-block rich text (paragraph blocks, descriptions, endings). Enter on an empty last line or Mod+Enter moves on. */
export function RichEditor(props: RichEditorProps) {
  return <EditorFrame kind="rich" {...(props as RichTextEditorProps<InlineDoc | RichDoc> & Omit<RichEditorProps, keyof RichTextEditorProps<RichDoc>>)} />;
}
