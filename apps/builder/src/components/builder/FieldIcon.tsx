import { createElement } from 'react';
import { iconFor } from '@/fields/icons';
import { TILE_STYLE, type Tile } from '@/fields/tiles';
import { cn } from '@/lib/utils';

/** A palette tile's icon: the registry entry's icon on its category colour. */
export function FieldTile({ tile }: { tile: Pick<Tile, 'icon' | 'category'> }) {
  return (
    <span className={cn('inline-flex size-[22px] shrink-0 items-center justify-center rounded-[4px]', TILE_STYLE[tile.category])} aria-hidden>
      {createElement(iconFor(tile.icon), { className: 'size-3.5' })}
    </span>
  );
}
