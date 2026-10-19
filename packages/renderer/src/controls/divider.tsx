import { cssColor } from '../theme/cssVars.ts';
import type { ControlProps } from './hooks.ts';

/** FLD-47. */
export function Divider({ block }: ControlProps<'divider'>) {
  const c = block.config;
  const color = cssColor(c.color);
  return (
    <hr
      className="fr-divider"
      data-spacing={c.spacing}
      data-line={c.lineStyle}
      style={color ? { borderColor: color } : undefined}
    />
  );
}
