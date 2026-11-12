import type { CSSProperties } from 'react';
import type { BlockId, SectionNav as SectionNavConfig } from '@form/schema';
import type { FormSection } from './sections.ts';
import { SUBMIT_SECTION_ID } from './sections.ts';

export type SectionStepState = 'complete' | 'current' | 'upcoming';

export interface SectionStep {
  id: BlockId;
  label: string;
  state: SectionStepState;
}

export function stepsFor(
  sections: readonly FormSection[],
  currentIndex: number,
  nav: SectionNavConfig,
  submitLabel: string,
  onSubmitStep: boolean,
): SectionStep[] {
  const steps: SectionStep[] = sections.map((section, i) => ({
    id: section.id,
    label: section.name,
    state: i < currentIndex ? 'complete' : i === currentIndex && !onSubmitStep ? 'current' : 'upcoming',
  }));
  if (nav.includeSubmit) {
    steps.push({
      id: SUBMIT_SECTION_ID,
      label: nav.submitLabel?.trim() || submitLabel,
      state: onSubmitStep ? 'current' : currentIndex >= sections.length - 1 && sections.length > 0 ? 'upcoming' : 'upcoming',
    });
    if (onSubmitStep) {
      for (const step of steps) if (step.id !== SUBMIT_SECTION_ID) step.state = 'complete';
    }
  }
  return steps;
}

const CONNECTOR: Record<SectionNavConfig['connector'], string> = {
  arrow: '→',
  chevron: '›',
  line: '',
  none: '',
};

export function SectionNav({
  steps,
  nav,
  onSelect,
}: {
  steps: readonly SectionStep[];
  nav: SectionNavConfig;
  onSelect?: (id: BlockId) => void;
}) {
  if (steps.length === 0) return null;
  const connector = CONNECTOR[nav.connector];
  const style: CSSProperties = {
    ...(nav.color ? { ['--fr-section-color' as string]: nav.color } : {}),
    ...(nav.labelColor ? { ['--fr-section-label' as string]: nav.labelColor } : {}),
    ...(nav.labelSizePx ? { fontSize: `${nav.labelSizePx}px` } : {}),
  };
  return (
    <nav
      className="fr-section-nav"
      data-placement={nav.placement}
      data-variant={nav.variant}
      data-mode={nav.mode}
      data-size={nav.size}
      data-align={nav.align}
      data-sticky={nav.sticky ? 'true' : 'false'}
      data-current={nav.currentMarker}
      data-completed={nav.completedMarker}
      data-chrome={nav.chrome ?? 'cards'}
      aria-label="Form sections"
      style={style}
    >
      <ol className="fr-section-nav-list">
        {steps.map((step, i) => {
          const interactive = Boolean(onSelect) && step.id !== SUBMIT_SECTION_ID;
          const inner = (
            <>
              {nav.variant === 'dots' && (nav.chrome ?? 'cards') !== 'circles' ? <span className="fr-section-nav-dot" aria-hidden /> : null}
              {nav.variant === 'numbers' || nav.showIndex || (nav.chrome ?? 'cards') === 'circles' || (nav.variant === 'stepper' && nav.completedMarker === 'check' && step.state === 'complete') ? (
                <span className="fr-section-nav-index" aria-hidden>
                  {step.state === 'complete' && nav.completedMarker === 'check' ? '✓' : i + 1}
                </span>
              ) : null}
              {nav.variant !== 'dots' ? <span className="fr-section-nav-label">{step.label}</span> : null}
            </>
          );
          return (
            <li key={step.id} className="fr-section-nav-item" data-state={step.state}>
              {i > 0 && nav.connector !== 'none' ? (
                <span className="fr-section-nav-connector" aria-hidden>
                  {connector}
                </span>
              ) : null}
              {interactive ? (
                <button
                  type="button"
                  className="fr-section-nav-step"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(step.id);
                  }}
                >
                  {inner}
                </button>
              ) : (
                <span className="fr-section-nav-step" aria-current={step.state === 'current' ? 'step' : undefined}>
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
