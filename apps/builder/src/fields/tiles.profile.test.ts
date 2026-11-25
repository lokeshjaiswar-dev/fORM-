import { describe, expect, it } from 'vitest';
import { DMS_TILES, TILES, matchTiles, tilesFor } from '@/fields/tiles';

const EDITION = { features: {} } as never;

describe('tilesFor', () => {
  it('full is today\'s palette, unchanged, and still has the page break', () => {
    expect(tilesFor('full')).toBe(TILES);
    expect(TILES.some((t) => t.kind === 'page_break')).toBe(true);
    expect(TILES.length).toBeGreaterThan(20);
  });

  it('dms-v1 is exactly the seven DMS tiles: DMS labels, toolbox order, blocks only', () => {
    expect(tilesFor('dms-v1')).toBe(DMS_TILES);
    expect(DMS_TILES.map((t) => t.label)).toEqual(['Text Input', 'Number Input', 'Email', 'Phone Number', 'Multi-line Input', 'Dropdown', 'Date']);
    expect(DMS_TILES.every((t) => t.kind === 'block')).toBe(true);
    expect(new Set(DMS_TILES.map((t) => t.id)).size).toBe(7);
  });
});

describe('matchTiles with a profile', () => {
  it('lists the seven for an empty query under dms-v1 and ignores library fields and the section navigator', () => {
    const extra = [{ kind: 'block', id: 'custom.x', choice: { type: 'short_text', configOverrides: {} }, category: 'snippets', label: 'Mine', icon: 'type', keywords: [] } as const];
    const all = matchTiles('', EDITION, extra, { profile: 'dms-v1', sectionNav: true });
    expect(all.map((t) => t.label)).toEqual(DMS_TILES.map((t) => t.label));
    expect(matchTiles('', EDITION, extra).some((t) => t.id === 'custom.x')).toBe(true);
  });

  it('searches the DMS labels and keywords', () => {
    expect(matchTiles('mobile', EDITION, [], { profile: 'dms-v1' }).map((t) => t.label)).toEqual(['Phone Number']);
    expect(matchTiles('drop', EDITION, [], { profile: 'dms-v1' }).map((t) => t.label)).toEqual(['Dropdown']);
    expect(matchTiles('page break', EDITION, [], { profile: 'dms-v1' })).toEqual([]);
    expect(matchTiles('rating', EDITION, [], { profile: 'dms-v1' })).toEqual([]);
  });

  it('every dms tile starts a block the translator writes back as its own DMS type', () => {
    for (const tile of DMS_TILES) {
      if (tile.kind !== 'block') continue;
      expect(tile.choice.type).toMatch(/^(short_text|phone|number|email|long_text|single_choice|date)$/);
    }
  });
});
