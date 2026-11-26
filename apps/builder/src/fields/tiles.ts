import { isEditionFeatureAvailable, type EditionFeatures } from '@form/config';
import { defineMessages, type MessageId } from '@form/i18n';
import { AVAILABLE_TYPES, REGISTRY, type AvailableType } from '@form/registry';
import { DMS_V1_TILES } from '@form/registry/profiles/dms-v1';
import type { PaletteEntry } from '@form/schema';
import type { CustomField } from '@/fields/custom/model';
import { t } from '@/i18n';
import type { ProfileName } from '@/embed/launch';
import type { BlockChoice } from '@/state/actions';

/*
 * The palette and the slash menu are views of the registry's `palette` entries (FND-03): one tile per entry of every
 * available type, grouped by the entry's category, labelled from the builder catalogue. The page break is the one
 * builder tile: pages are structure in v2, not a block type.
 */

export type Category = PaletteEntry<AvailableType>['category'];

const M = defineMessages('builder', {
  'palette.category.basic': 'Common',
  'palette.category.contact': 'Contact',
  'palette.category.choice': 'Choices',
  'palette.category.date_time': 'Date and time',
  'palette.category.rating': 'Survey',
  'palette.category.media': 'Media',
  'palette.category.layout': 'Layout',
  'palette.category.advanced': 'Advanced',
  'palette.category.snippets': 'Your fields',
  'palette.page_break': 'Page break',
});

export type Tile =
  | { kind: 'block'; id: string; choice: BlockChoice; category: Category; label: string; icon: string; keywords: readonly string[]; required?: boolean }
  | { kind: 'page_break'; id: 'page_break'; category: Category; label: string; icon: string; keywords: readonly string[] };

/** Categories in palette order; custom library fields use `snippets`. */
export const CATEGORIES: readonly Category[] = ['basic', 'choice', 'date_time', 'rating', 'media', 'layout', 'advanced', 'snippets'];

const CATEGORY_LABELS: Partial<Record<Category, MessageId>> = {
  basic: M['palette.category.basic'],
  contact: M['palette.category.contact'],
  choice: M['palette.category.choice'],
  date_time: M['palette.category.date_time'],
  rating: M['palette.category.rating'],
  media: M['palette.category.media'],
  layout: M['palette.category.layout'],
  advanced: M['palette.category.advanced'],
  snippets: M['palette.category.snippets'],
};

export const categoryLabel = (category: Category): string => {
  const id = CATEGORY_LABELS[category];
  return id ? t(id) : category;
};

/**
 * Tile colours per category (icon tile background and glyph). Every category uses the same light blue (#b7d0ff) for
 * now; give a category its own colour here to tell groups apart again.
 */
const TILE_GLYPH = 'text-[#0c1927]';
const TILE_LIGHT_BLUE = `bg-[#b7d0ff] ${TILE_GLYPH}`;
export const TILE_STYLE: Readonly<Record<Category, string>> = {
  basic: TILE_LIGHT_BLUE,
  contact: TILE_LIGHT_BLUE,
  choice: TILE_LIGHT_BLUE,
  date_time: TILE_LIGHT_BLUE,
  rating: TILE_LIGHT_BLUE,
  media: TILE_LIGHT_BLUE,
  layout: TILE_LIGHT_BLUE,
  advanced: TILE_LIGHT_BLUE,
  payments: TILE_LIGHT_BLUE,
  compliance: TILE_LIGHT_BLUE,
  snippets: TILE_LIGHT_BLUE,
};

function blockTiles(type: AvailableType): Tile[] {
  const palette = REGISTRY[type].palette as ReadonlyArray<PaletteEntry<AvailableType>>;
  return palette.map((entry) => ({
    kind: 'block',
    id: entry.id,
    choice: { type, configOverrides: entry.configOverrides },
    category: entry.category,
    label: t(entry.labelKey as MessageId),
    icon: entry.icon,
    keywords: entry.keywords,
  }));
}

const PAGE_BREAK: Tile = { kind: 'page_break', id: 'page_break', category: 'layout', label: t(M['palette.page_break']), icon: 'file-plus', keywords: ['page', 'break', 'step', 'next'] };

/** Types kept in the registry for existing forms, but not offered in the picker or slash menu. */
export const HIDDEN_PALETTE_TYPES = new Set<AvailableType>(['nps', 'likert', 'constant_sum', 'maxdiff', 'semantic_differential', 'captcha', 'linear_scale', 'unique_id', 'hidden']);

/** Palette variants hidden even when their type stays in the picker (e.g. PIN code under short text). */
export const HIDDEN_PALETTE_IDS = new Set(['short_text.pincode', 'file_upload.photo']);

const allTiles: readonly Tile[] = (() => {
  const all = [...AVAILABLE_TYPES.flatMap(blockTiles), PAGE_BREAK];
  return CATEGORIES.flatMap((c) => all.filter((tile) => tile.category === c));
})();

/** Palette tiles, in category order: hidden survey types are omitted. */
export const TILES: readonly Tile[] = allTiles.filter(
  (tile) => tile.kind === 'page_break' || (!HIDDEN_PALETTE_TYPES.has(tile.choice.type) && !HIDDEN_PALETTE_IDS.has(tile.id)),
);

/**
 * The dms-v1 palette (DESIGN section 2): exactly DMS+'s seven field types, with DMS's labels, in its toolbox order. No
 * page break, no template or library fields.
 */
export const DMS_TILES: readonly Tile[] = DMS_V1_TILES.map((tile) => ({
  kind: 'block' as const,
  id: `dms.${tile.id}`,
  choice: { type: tile.type, configOverrides: tile.configOverrides as BlockChoice['configOverrides'] },
  category: 'basic' as const,
  label: tile.label,
  icon: tile.icon,
  keywords: tile.keywords,
}));

/** The palette tiles a profile offers, before search and edition filtering. */
export const tilesFor = (profile: ProfileName): readonly Tile[] => (profile === 'dms-v1' ? DMS_TILES : TILES);

/**
 * The tile of a block type, for the settings header, the canvas and the drag overlay: the palette entry whose settings
 * the block still has; otherwise the closest one (the most settings in common, then the fewest settings of its own),
 * so a dropdown with "Search options" turned off is still a "Dropdown"; otherwise the type's own entry.
 */
export const tileOf = (type: string, overrides?: Readonly<Record<string, unknown>>): Tile | undefined => {
  const of = allTiles.filter((tile) => tile.kind === 'block' && tile.choice.type === type);
  const settings = (tile: Tile) => (tile.kind === 'block' ? Object.entries(tile.choice.configOverrides) : []);
  if (overrides) {
    const match = of.find((tile) => settings(tile).every(([k, v]) => overrides[k] === v));
    if (match) return match;
    let closest: Tile | undefined;
    let best = 0;
    for (const tile of of) {
      const shared = settings(tile).filter(([k, v]) => overrides[k] === v).length;
      if (shared > best || (shared === best && shared > 0 && closest && settings(tile).length < settings(closest).length)) {
        closest = tile;
        best = shared;
      }
    }
    if (closest) return closest;
  }
  return of.find((tile) => tile.id === type) ?? of[0];
};

/** Whether the edition runs the tile's block type (`field:<type>`); a disabled feature is hidden (architecture §1.5). */
export const tileAvailable = (tile: Tile, edition: EditionFeatures): boolean =>
  tile.kind === 'page_break' || isEditionFeatureAvailable(edition, `field:${tile.choice.type}`);

/** Palette tiles for saved library fields. Insert copies the stored config onto a normal block. */
export function tilesFromCustomFields(fields: readonly CustomField[]): Tile[] {
  return fields.map((field) => ({
    kind: 'block' as const,
    id: `custom.${field.id}`,
    choice: { type: field.baseType, configOverrides: field.config },
    category: 'snippets' as const,
    label: field.name,
    icon: field.icon,
    keywords: field.keywords,
    required: field.required,
  }));
}

/** The edition's tiles whose label, id or keywords contain `query` (case-insensitive); all of them for an empty query. */
export function matchTiles(query: string, edition: EditionFeatures, extra: readonly Tile[] = [], opts: { sectionNav?: boolean; profile?: ProfileName } = {}): Tile[] {
  const q = query.trim().toLowerCase();
  const profile = opts.profile ?? 'full';
  return [...tilesFor(profile), ...(profile === 'full' ? extra : [])].filter(
    (tile) =>
      (tile.kind !== 'block' || tile.choice.type !== 'section_break' || opts.sectionNav === true) &&
      tileAvailable(tile, edition) &&
      (!q || tile.label.toLowerCase().includes(q) || tile.id.replaceAll('_', ' ').includes(q) || tile.keywords.some((k) => k.includes(q))),
  );
}
