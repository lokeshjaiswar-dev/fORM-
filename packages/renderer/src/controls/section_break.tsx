import type { ControlProps } from './hooks.ts';

/** Marker for a named section; optional in-form heading. The navigator lives on the form chrome. */
export function SectionBreak({ block }: ControlProps<'section_break'>) {
  const c = block.config;
  const marker = c.marker ?? 'card';
  return (
    <div className="fr-section-break" data-fr-section={block.id} data-marker={marker} id={`section-${block.id}`}>
      <div className="fr-section-break-mark">
        {marker === 'badge' ? <span className="fr-section-break-badge" aria-hidden /> : null}
        <span className="fr-section-break-name">{c.name}</span>
      </div>
      {c.description ? <p className="fr-section-break-desc">{c.description}</p> : null}
    </div>
  );
}
