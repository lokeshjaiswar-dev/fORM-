import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RESTRICTED_EDITION, editionSummary, loadEditionConfig } from '@form/config';
import { AVAILABLE_TYPES, REGISTRY, STUB_AVAILABILITY } from '@form/registry';
import { CONTROLS } from '@form/renderer';
import type { BlockId, PaletteEntry } from '@form/schema';
import { CANVAS } from '@/fields/canvas';
import { ICONS } from '@/fields/icons';
import { INSPECTOR } from '@/fields/inspector';
import { CATEGORIES, TILES, matchTiles, tileAvailable, tileOf, type Tile } from '@/fields/tiles';
import { EditBlock } from '@/components/blocks/EditBlock';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { useUiStore } from '@/state/uiStore';
import { block, resetStore } from '@/test/fixtures';

describe('registry views (FND-03)', () => {
  it('every available type has a canvas view, an inspector entry, a known palette icon and a renderer control', () => {
    for (const type of AVAILABLE_TYPES) {
      expect(CANVAS[type], type).toBeTypeOf('function');
      expect(INSPECTOR[type], type).toBeTypeOf('object');
      expect(CONTROLS[type as keyof typeof CONTROLS], type).toBeDefined();
      const palette = REGISTRY[type].palette as ReadonlyArray<PaletteEntry<typeof type>>;
      expect(palette.length, type).toBeGreaterThan(0);
      for (const entry of palette) expect(ICONS[entry.icon], `${type}: ${entry.icon}`).toBeDefined();
    }
  });

  it('the palette is the registry palette: one tile per entry of every available type, plus the page break', () => {
    const entries = AVAILABLE_TYPES.flatMap((type) => (REGISTRY[type].palette as ReadonlyArray<PaletteEntry<typeof type>>).map((e) => e.id));
    expect(TILES.filter((t) => t.kind === 'block').map((t) => t.id).sort()).toEqual([...entries].sort());
    expect(TILES.filter((t) => t.kind === 'page_break')).toHaveLength(1);
    expect(TILES.every((t) => CATEGORIES.includes(t.category))).toBe(true);
    expect(TILES.some((t) => t.kind === 'block' && Object.keys(STUB_AVAILABILITY).includes(t.choice.type))).toBe(false);
  });

  it('tiles are labelled from the builder catalogue and found by label, id or keyword', () => {
    expect(tileOf('short_text')?.label).toBe('Short answer');
    expect(tileOf('single_choice', { display: 'dropdown' })?.label).toBe('Dropdown');
    const saas = editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' }));
    expect(matchTiles('nps', saas).map((t) => t.id)).toEqual(['nps']);
    expect(matchTiles('dob', saas).map((t) => t.id)).toEqual(['date']);
    expect(matchTiles('page', saas).map((t) => t.id)).toContain('page_break');
    expect(matchTiles('', saas)).toHaveLength(TILES.length);
  });

  it('edition matrix: a tile is hidden where the edition cannot run its type (FND-19)', () => {
    const payment = { ...TILES[0], kind: 'block', id: 'payment', choice: { type: 'payment', configOverrides: {} } } as unknown as Tile;
    const editions = {
      saas: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' })),
      onprem: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem' })),
      onpremPayments: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', PAYMENTS_ENABLED: 'razorpay' })),
      airGapped: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' })),
      unknown: RESTRICTED_EDITION,
    };
    expect(Object.fromEntries(Object.entries(editions).map(([k, e]) => [k, tileAvailable(payment, e)]))).toEqual({
      saas: true,
      onprem: false,
      onpremPayments: true,
      airGapped: false,
      unknown: false,
    });
    /* Every P0 palette type runs everywhere: the air-gapped palette is the full palette. */
    for (const e of Object.values(editions)) expect(matchTiles('', e)).toHaveLength(TILES.length);
  });

  it('every available type renders on the canvas', () => {
    resetStore(AVAILABLE_TYPES.map((type) => block(type, `b_${type}`, ['heading', 'paragraph', 'divider'].includes(type) ? {} : { label: `Label ${type}` })));
    for (const type of AVAILABLE_TYPES) {
      const { container, unmount } = render(<EditBlock block={block(type, `b_${type}`, ['heading', 'paragraph', 'divider'].includes(type) ? {} : { label: `Label ${type}` })} />);
      expect(container.firstChild, type).not.toBeNull();
      if (!['heading', 'paragraph', 'divider'].includes(type)) expect(screen.getByText(`Label ${type}`), type).toBeInTheDocument();
      unmount();
    }
  });

  const CONTENT = ['heading', 'paragraph', 'divider'];
  it.each(AVAILABLE_TYPES)('%s opens in the inspector with its sections, and each section renders', (type) => {
    resetStore(AVAILABLE_TYPES.map((t) => block(t, `b_${t}`, CONTENT.includes(t) ? {} : { label: `Label ${t}` })));
    useUiStore.getState().openInspector(`b_${type}` as BlockId);
    render(<BlockInspector />);
    const view = INSPECTOR[type] as { options?: unknown };
    const field = !CONTENT.includes(type);
    const expected = ['General', ...(view.options ? ['Options'] : []), ...(field ? ['Validation'] : []), 'Logic', ...(field ? ['Privacy'] : [])];
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(expected);
    for (const name of expected) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      expect(within(screen.getByRole('tabpanel')).queryAllByText(/./).length, name).toBeGreaterThan(0);
    }
  });

  it('a block of a type this builder cannot edit is kept and labelled', () => {
    render(<EditBlock block={{ id: 'x' as never, type: 'unsupported', originalType: 'hologram', raw: {} }} />);
    expect(screen.getByText(/This hologram block cannot be edited/)).toBeInTheDocument();
  });
});
