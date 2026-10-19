import { RichTextView } from '../richtext/RichTextView.tsx';
import { usePipes, type ControlProps } from './hooks.ts';

/** FLD-44. The form title is the page's h1, so heading levels 1–3 render as h2–h4. */
export function Heading({ block }: ControlProps<'heading'>) {
  const { resolve } = usePipes();
  const c = block.config;
  const Tag = (['h2', 'h3', 'h4'] as const)[c.level - 1] ?? 'h2';
  return (
    <div className="fr-heading-block" data-level={c.level} style={c.align ? { textAlign: c.align } : undefined}>
      <Tag className="fr-heading">
        <RichTextView doc={c.text} inline resolve={resolve} />
      </Tag>
      {c.subheading ? (
        <p className="fr-subheading">
          <RichTextView doc={c.subheading} inline resolve={resolve} />
        </p>
      ) : null}
    </div>
  );
}
