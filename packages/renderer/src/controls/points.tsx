import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface PointsProps {
  points: readonly number[];
  /** Unanswered is no selection (B7): 0 is a real NPS or scale answer, never the empty state. */
  value: number | undefined;
  /** Undefined when the respondent clicks the selected point again (pointer only): an optional scale can be emptied. */
  onChange: (value: number | undefined) => void;
  onBlur?: () => void;
  disabled: boolean;
  inputId: string;
  /** Accessible name of a point when its content is not text (icons). */
  label?: (value: number) => string;
  render: (value: number, selected: boolean) => ReactNode;
  low?: string | undefined;
  high?: string | undefined;
  variant: 'icons' | 'boxes';
}

/**
 * A row of `role="radio"` buttons for rating, linear scale and NPS. The shell's `role="radiogroup"` names it; one point
 * is in the tab order (the selected one, else the first) and the arrow keys, Home and End move and select.
 */
export function Points({ points, value, onChange, onBlur, disabled, inputId, label, render, low, high, variant }: PointsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = value === undefined ? -1 : points.indexOf(value);
  const move = (index: number) => {
    const next = points[index];
    if (next === undefined) return;
    onChange(next);
    refs.current[index]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = points.length - 1;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (index >= last ? 0 : index + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (index <= 0 ? last : index - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    move(to);
  };
  return (
    <div className="fr-points" data-variant={variant}>
      {low ? <span className="fr-point-label">{low}</span> : null}
      <div className="fr-point-row">
        {points.map((n, i) => {
          const selected = i === current;
          return (
            <button
              key={n}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={i === 0 ? inputId : undefined}
              type="button"
              role="radio"
              className="fr-point"
              aria-checked={selected}
              aria-label={label?.(n)}
              tabIndex={selected || (current < 0 && i === 0) ? 0 : -1}
              disabled={disabled}
              onClick={(e) => onChange(selected && e.detail > 0 ? undefined : n)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onBlur={onBlur}
            >
              {render(n, value !== undefined && (variant === 'icons' ? n <= value : selected))}
            </button>
          );
        })}
      </div>
      {high ? <span className="fr-point-label">{high}</span> : null}
    </div>
  );
}
