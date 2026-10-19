import { RichTextView } from '../richtext/RichTextView.tsx';
import { usePipes, type ControlProps } from './hooks.ts';

/** FLD-45: rich text as React elements (WP-0.08), with live pipes. */
export function Paragraph({ block }: ControlProps<'paragraph'>) {
  const { resolve } = usePipes();
  return (
    <div className="fr-rich">
      <RichTextView doc={block.config.content} resolve={resolve} />
    </div>
  );
}
