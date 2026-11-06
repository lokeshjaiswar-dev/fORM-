import { useState } from 'react';
import { isAvailable } from '@form/registry';
import type { StoredBlock } from '@form/schema';
import { useRenderer } from '../context.ts';
import { Block } from '../fields/Field.tsx';
import { RichTextView } from '../richtext/RichTextView.tsx';
import { usePipes, type ControlProps } from './hooks.ts';

/** FLD-48: title, optional description, then nested blocks. */
export function Section({ block }: ControlProps<'section'>) {
  const { def } = useRenderer();
  const { resolve } = usePipes();
  const c = block.config;
  const [open, setOpen] = useState(c.initiallyCollapsed !== true);
  const children = c.children.map((id) => def.blocks[id]).filter((b): b is StoredBlock => !!b && b.type !== 'unsupported' && isAvailable(b.type));
  const body = (
    <div className="fr-section-body">
      {c.description ? <div className="fr-section-desc fr-rich"><RichTextView doc={c.description} resolve={resolve} /></div> : null}
      {children.map((child) => <Block key={child.id} block={child} />)}
    </div>
  );
  if (!c.collapsible) {
    return (
      <section className="fr-section">
        {c.title ? <h2 className="fr-section-title"><RichTextView doc={c.title} inline resolve={resolve} /></h2> : null}
        {body}
      </section>
    );
  }
  return (
    <section className="fr-section">
      <button type="button" className="fr-section-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="fr-section-title"><RichTextView doc={c.title} inline resolve={resolve} /></span>
      </button>
      {open ? body : null}
    </section>
  );
}
